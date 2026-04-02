const https = require("https");

// ─── Helpers ────────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse response: " + data));
        }
      });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Squarespace ─────────────────────────────────────────────────────────────

async function getRecentOrders() {
  // Pull orders from the last 10 minutes to ensure we don't miss any
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const url = `https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=${since}&fulfillmentStatus=FULFILLED,PENDING`;

  const data = await httpsGet(url, {
    Authorization: `Bearer ${process.env.SQUARESPACE_API_KEY}`,
    "User-Agent": "SFTGear-GA4-Tracker/1.0",
  });

  return data.result || [];
}

// ─── GA4 Measurement Protocol ────────────────────────────────────────────────

async function sendPurchaseEvent(order) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  // Build items array from Squarespace line items
  const items = (order.lineItems || []).map((item, index) => ({
    item_id: item.variantId || item.productId || `item_${index}`,
    item_name: item.productName || "Unknown Product",
    price: parseFloat(item.unitPricePaid?.value || 0),
    quantity: item.quantity || 1,
  }));

  const revenue = parseFloat(order.grandTotal?.value || 0);
  const tax = parseFloat(order.taxTotal?.value || 0);
  const shipping = parseFloat(order.shippingTotal?.value || 0);

  const payload = {
    client_id: order.customerEmail || order.id, // best available client identifier
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: order.orderNumber?.toString() || order.id,
          value: revenue,
          tax: tax,
          shipping: shipping,
          currency: order.grandTotal?.currency || "USD",
          items: items,
        },
      },
    ],
  };

  const path = `/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  const result = await httpsPost("www.google-analytics.com", path, payload);
  return result;
}

// ─── Deduplication ───────────────────────────────────────────────────────────
// Netlify functions are stateless, so we use a simple in-memory set per
// execution. For a low-volume store this is sufficient — the 10-minute
// lookback window combined with order status filtering prevents most duplicates.
// If you see duplicate events in GA4, the order status filter below is the
// first thing to tighten.

const processedOrders = new Set();

// ─── Main Handler ─────────────────────────────────────────────────────────────

exports.handler = async function (event, context) {
  try {
    const orders = await getRecentOrders();

    if (orders.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No recent orders found" }),
      };
    }

    const results = [];

    for (const order of orders) {
      // Skip if already processed in this execution
      if (processedOrders.has(order.id)) {
        results.push({ orderId: order.id, status: "skipped - duplicate" });
        continue;
      }

      // Only process orders that are confirmed/pending fulfillment
      // This filters out cancelled or refunded orders
      const validStatuses = ["PENDING", "FULFILLED"];
      if (!validStatuses.includes(order.fulfillmentStatus)) {
        results.push({ orderId: order.id, status: "skipped - invalid status" });
        continue;
      }

      const ga4Result = await sendPurchaseEvent(order);
      processedOrders.add(order.id);

      results.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        revenue: order.grandTotal?.value,
        ga4Status: ga4Result.status,
      });
    }

    console.log("Purchase tracking results:", JSON.stringify(results));

    return {
      statusCode: 200,
      body: JSON.stringify({ processed: results }),
    };
  } catch (error) {
    console.error("Purchase tracking error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
