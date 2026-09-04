const express = require("express");
const crypto = require("crypto");
const path = require("path");
const session = require("express-session");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const PAYMENT_DESTINATION =
  process.env.PAYMENT_DESTINATION || "YOUR_AUTHORIZED_PAYMENT_ID";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not configured.");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.error("ERROR: ADMIN_PASSWORD is not configured.");
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error("ERROR: SESSION_SECRET is not configured.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));


/* =========================
   DATABASE
========================= */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}


/* =========================
   HELPERS
========================= */

function createOrderId() {
  return (
    "ORD-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized."
  });
}


/* =========================
   CUSTOMER API
========================= */

app.get("/api/config", function (req, res) {
  res.json({
    paymentDestination: PAYMENT_DESTINATION
  });
});


app.post("/api/orders", async function (req, res) {
  try {
    const amount = Number(req.body.amount);

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

    const id = createOrderId();

    const now = new Date();

    const expiresAt = new Date(
      now.getTime() + 2 * 60 * 60 * 1000
    );

    const cents = Math.round(amount * 100);

    await pool.query(
      `
      INSERT INTO orders
      (id, amount_cents, status, created_at, updated_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        id,
        cents,
        "PAYMENT_PENDING",
        now,
        now,
        expiresAt
      ]
    );

    res.json({
      id: id,
      amount: cents / 100,
      amount_cents: cents,
      status: "PAYMENT_PENDING",
      paymentDestination: PAYMENT_DESTINATION,
      expiresAt: expiresAt.toISOString()
    });

  } catch (error) {
    console.error("Create order error:", error);

    res.status(500).json({
      error: "Unable to create order."
    });
  }
});


app.post("/api/orders/:id/payment-submitted", async function (req, res) {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    const order = result.rows[0];

    if (
      order.status === "PAYMENT_PENDING" &&
      new Date(order.expires_at).getTime() <= Date.now()
    ) {
      await pool.query(
        `
        UPDATE orders
        SET status = $1, updated_at = $2
        WHERE id = $3
        `,
        [
          "EXPIRED",
          new Date(),
          order.id
        ]
      );

      return res.status(400).json({
        error: "This order has expired."
      });
    }

    if (order.status !== "PAYMENT_PENDING") {
      return res.status(400).json({
        error: "Order is already " + order.status + "."
      });
    }

    const now = new Date();

    await pool.query(
      `
      UPDATE orders
      SET status = $1, updated_at = $2
      WHERE id = $3
      `,
      [
        "VERIFICATION_PENDING",
        now,
        order.id
      ]
    );

    res.json({
      id: order.id,
      status: "VERIFICATION_PENDING"
    });

  } catch (error) {
    console.error("Payment submission error:", error);

    res.status(500).json({
      error: "Unable to update order."
    });
  }
});


app.get("/api/orders/:id", async function (req, res) {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    const order = result.rows[0];

    if (
      order.status === "PAYMENT_PENDING" &&
      new Date(order.expires_at).getTime() <= Date.now()
    ) {
      const now = new Date();

      await pool.query(
        `
        UPDATE orders
        SET status = $1, updated_at = $2
        WHERE id = $3
        `,
        [
          "EXPIRED",
          now,
          order.id
        ]
      );

      order.status = "EXPIRED";
      order.updated_at = now;
    }

    res.json({
      id: order.id,
      amount: order.amount_cents / 100,
      amount_cents: order.amount_cents,
      status: order.status,
      createdAt: new Date(order.created_at).toISOString(),
      updatedAt: new Date(order.updated_at).toISOString(),
      expiresAt: new Date(order.expires_at).toISOString()
    });

  } catch (error) {
    console.error("Get order error:", error);

    res.status(500).json({
      error: "Unable to retrieve order."
    });
  }
});


/* =========================
   ADMIN AUTHENTICATION
========================= */

app.post("/api/admin/login", function (req, res) {
  const password = String(req.body.password || "");

  const supplied = Buffer.from(password);
  const expected = Buffer.from(ADMIN_PASSWORD);

  let valid = false;

  if (supplied.length === expected.length) {
    valid = crypto.timingSafeEqual(supplied, expected);
  }

  if (!valid) {
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


app.get("/api/admin/session", function (req, res) {
  res.json({
    authenticated:
      req.session &&
      req.session.isAdmin === true
  });
});


/* =========================
   ADMIN ORDER MANAGEMENT
========================= */

app.get("/api/admin/orders", requireAdmin, async function (req, res) {
  try {
    const result = await pool.query(`
      SELECT
        id,
        amount_cents,
        status,
        created_at,
        updated_at,
        expires_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 500
    `);

    res.json(
      result.rows.map(function (order) {
        return {
          id: order.id,
          amount: order.amount_cents / 100,
          amount_cents: order.amount_cents,
          status: order.status,
          createdAt: new Date(order.created_at).toISOString(),
          updatedAt: new Date(order.updated_at).toISOString(),
          expiresAt: new Date(order.expires_at).toISOString()
        };
      })
    );

  } catch (error) {
    console.error("Admin orders error:", error);

    res.status(500).json({
      error: "Unable to retrieve orders."
    });
  }
});


app.post(
  "/api/admin/orders/:id/status",
  requireAdmin,
  async function (req, res) {
    try {
      const newStatus = String(req.body.status || "");

      if (!["COMPLETED", "CANCELLED"].includes(newStatus)) {
        return res.status(400).json({
          error: "Invalid status."
        });
      }

      const result = await pool.query(
        "SELECT * FROM orders WHERE id = $1",
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Order not found."
        });
      }

      const order = result.rows[0];

      if (order.status !== "VERIFICATION_PENDING") {
        return res.status(400).json({
          error:
            "Only VERIFICATION_PENDING orders can be completed or cancelled."
        });
      }

      const now = new Date();

      await pool.query(
        `
        UPDATE orders
        SET status = $1, updated_at = $2
        WHERE id = $3
        `,
        [
          newStatus,
          now,
          order.id
        ]
      );

      res.json({
        id: order.id,
        status: newStatus
      });

    } catch (error) {
      console.error("Admin status update error:", error);

      res.status(500).json({
        error: "Unable to update order."
      });
    }
  }
);


/* =========================
   HEALTH
========================= */

app.get("/health", async function (req, res) {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });

  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});


/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    await initializeDatabase();

    console.log("");
    console.log("======================================");
    console.log("  PAYMENT ORDER PROTOTYPE");
    console.log("======================================");
    console.log("PostgreSQL connected");
    console.log("Admin authentication enabled");
    console.log("Running at: http://localhost:" + PORT);
    console.log("");

    app.listen(PORT);

  } catch (error) {
    console.error("Database startup error:");
    console.error(error);
    process.exit(1);
  }
}

startServer();