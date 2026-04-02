const https = require("https");
const { getStore } = require("@netlify/blobs");

// ─── Helpers ────────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
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
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const url = `https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=${since}&modifiedBefore=${now}`;

  console.log("Fetching orders since:", since);

  const result = await httpsGet(url, {
    Authorization: `Bearer ${process.env.SQUARESPACE_API_KEY}`,
    "User-Agent": "SFTGear-GA4-Tracker/1.0",
  });

  console.log("Squarespace API status:", result.status);

  if (result.status !== 200) {
    throw new Error(`Squarespace API error: ${result.status} - ${JSON.stringify(result.body)}`);
  }

  const orders = result.body.result || [];
  console.log(`Found ${orders.length} orders`);
  return orders;
}

// ─── GA4 Measurement Protocol ────────────────────────────────────────────────

async function sendPurchaseEvent(order) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  const items = (order.lineItems || []).map((item, index) => ({
    item_id: item.variantId || item.productId || `item_${index}`,
    item_name: item.productName || "Unknown Product",
    price: parseFloat(item.unitPricePaid?.value || 0),
    quantity: item.quantity || 1,
  }));

  const revenue = parseFloat(order.grandTotal?.value || 0);
  const tax = parseFloat(order.taxTotal?.value || 0);
  const shipping = parseFloat(order.shippingTotal?.value || 0);

  // Skip test orders from being sent to GA4
  if (order.testmode) {
    console.log(`Skipping test order ${order.orderNumber}`);
    return { status: "skipped - test order" };
  }

  const payload = {
    client_id: order.customerEmail || order.id,
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

  console.log(`Sending purchase to GA4: order ${order.orderNumber}, total $${revenue}`);

  const path = `/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;
  const result = await httpsPost("www.google-analytics.com", path, payload);

  console.log("GA4 response status:", result.status);
  return result;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

exports.handler = async function (event, context) {
  try {
    // Initialize blob store for deduplication
    const store = getStore("processed-orders");

    const orders = await getRecentOrders();

    if (orders.length === 0) {
      console.log("No recent orders found");
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No recent orders found" }),
      };
    }

    const results = [];

    for (const order of orders) {
      console.log(`Processing order: ${order.orderNumber} | status: ${order.fulfillmentStatus} | total: ${order.grandTotal?.value}`);

      // Check if already processed
      const alreadyProcessed = await store.get(order.id);
      if (alreadyProcessed) {
        console.log(`Skipping order ${order.orderNumber} - already sent to GA4`);
        results.push({ orderId: order.id, orderNumber: order.orderNumber, status: "skipped - already processed" });
        continue;
      }

      // Skip cancelled or refunded orders
      const skipStatuses = ["CANCELED", "REFUNDED"];
      if (skipStatuses.includes(order.fulfillmentStatus)) {
        console.log(`Skipping order ${order.orderNumber} - status: ${order.fulfillmentStatus}`);
        results.push({ orderId: order.id, status: "skipped - " + order.fulfillmentStatus });
        continue;
      }

      const ga4Result = await sendPurchaseEvent(order);

      // Mark as processed so we don't send it again
      // Store for 7 days to cover any edge cases
      await store.set(order.id, order.orderNumber.toString(), { ttl: 60 * 60 * 24 * 7 });

      results.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        revenue: order.grandTotal?.value,
        fulfillmentStatus: order.fulfillmentStatus,
        ga4Status: ga4Result.status,
      });
    }

    console.log("Final results:", JSON.stringify(results));

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
