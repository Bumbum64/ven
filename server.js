const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const PAYMENT_DESTINATION = "YOUR_AUTHORIZED_PAYMENT_ID";
const ADMIN_PASSWORD = "Admin123!";

app.use(
  session({
    secret: "change-this-secret-later",
    resave: false,
    saveUninitialized: false
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("orders.db");

try {
  db.exec("ALTER TABLE orders ADD COLUMN expires_at TEXT");
} catch (error) {
}

db.exec(
  "CREATE TABLE IF NOT EXISTS orders (" +
  "id TEXT PRIMARY KEY, " +
  "amount_cents INTEGER NOT NULL, " +
  "status TEXT NOT NULL, " +
  "created_at TEXT NOT NULL, " +
  "updated_at TEXT NOT NULL, " +
  "expires_at TEXT)"
);

function createOrderId() {
  return "ORD-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  return res.status(401).json({
    error: "Admin login required."
  });
}

app.get("/api/config", function (req, res) {
  res.json({
    paymentDestination: PAYMENT_DESTINATION
  });
});

app.post("/api/orders", function (req, res) {
  var amount = Number(req.body.amount);

  if (!Number.isFinite(amount)) {
    return res.status(400).json({
      error: "Invalid amount."
    });
  }

  if (amount < 1 || amount > 10000) {
    return res.status(400).json({
      error: "Amount must be between $1 and $10,000."
    });
  }

  var id = createOrderId();
  var now = new Date();
  var createdAt = now.toISOString();

  var expiresAt = new Date(
    now.getTime() + 2 * 60 * 60 * 1000
  ).toISOString();

  var cents = Math.round(amount * 100);

  db.prepare(
    "INSERT INTO orders " +
    "(id, amount_cents, status, created_at, updated_at, expires_at) " +
    "VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    cents,
    "PAYMENT_PENDING",
    createdAt,
    createdAt,
    expiresAt
  );

  res.json({
    id: id,
    amount: cents / 100,
    status: "PAYMENT_PENDING",
    paymentDestination: PAYMENT_DESTINATION,
    expiresAt: expiresAt
  });
});

app.post("/api/orders/:id/payment-submitted", function (req, res) {
  var order = db.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      error: "Order not found."
    });
  }

  if (
    order.expires_at &&
    new Date(order.expires_at).getTime() <= Date.now()
  ) {
    if (order.status === "PAYMENT_PENDING") {
      db.prepare(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
      ).run(
        "EXPIRED",
        new Date().toISOString(),
        order.id
      );
    }

    return res.status(400).json({
      error: "This order has expired."
    });
  }

  if (order.status !== "PAYMENT_PENDING") {
    return res.status(400).json({
      error: "Order is already " + order.status + "."
    });
  }

  var now = new Date().toISOString();

  db.prepare(
    "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
  ).run(
    "VERIFICATION_PENDING",
    now,
    order.id
  );

  res.json({
    id: order.id,
    status: "VERIFICATION_PENDING"
  });
});

app.get("/api/orders/:id", function (req, res) {
  var order = db.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      error: "Order not found."
    });
  }

  if (
    order.expires_at &&
    new Date(order.expires_at).getTime() <= Date.now() &&
    order.status === "PAYMENT_PENDING"
  ) {
    db.prepare(
      "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
    ).run(
      "EXPIRED",
      new Date().toISOString(),
      order.id
    );

    order.status = "EXPIRED";
  }

  res.json({
    id: order.id,
    amount: order.amount_cents / 100,
    amount_cents: order.amount_cents,
    status: order.status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    expiresAt: order.expires_at
  });
});

app.post("/api/admin/login", function (req, res) {
  var password = req.body.password;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Invalid password."
    });
  }

  req.session.isAdmin = true;

  res.json({
    success: true
  });
});

app.post("/api/admin/logout", function (req, res) {
  req.session.destroy(function () {
    res.json({
      success: true
    });
  });
});

app.get("/api/admin/orders", requireAdmin, function (req, res) {
  var orders = db.prepare(
    "SELECT * FROM orders ORDER BY created_at DESC"
  ).all();

  res.json(
    orders.map(function (order) {
      return {
        id: order.id,
        amount: order.amount_cents / 100,
        status: order.status,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        expiresAt: order.expires_at
      };
    })
  );
});

app.post("/api/admin/orders/:id/status", requireAdmin, function (req, res) {
  var status = req.body.status;

  if (status !== "COMPLETED" && status !== "CANCELLED") {
    return res.status(400).json({
      error: "Invalid status."
    });
  }

  var order = db.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      error: "Order not found."
    });
  }

  var now = new Date().toISOString();

  db.prepare(
    "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
  ).run(
    status,
    now,
    order.id
  );

  res.json({
    id: order.id,
    status: status
  });
});

app.listen(PORT, function () {
  console.log("");
  console.log("======================================");
  console.log("  PAYMENT ORDER PROTOTYPE");
  console.log("======================================");
  console.log("Running at: http://localhost:3000");
  console.log("");
});