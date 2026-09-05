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
app.get("/admin.html", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});


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
   MARKETPLACE / TRADES
========================= */

async function initializeMarketplaceDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      seller_name TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      rate NUMERIC(12,6) NOT NULL,
      available_cents INTEGER NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL REFERENCES offers(id),
      amount_cents INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      rate NUMERIC(12,6) NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM offers"
  );

  if (countResult.rows[0].count === 0) {
    const now = new Date();

    const demoOffers = [
      {
        id: "OFR-DEMO-001",
        sellerName: "Demo Seller 1",
        paymentMethod: "VENMO",
        rate: 1.00,
        availableCents: 100000
      },
      {
        id: "OFR-DEMO-002",
        sellerName: "Demo Seller 2",
        paymentMethod: "VENMO",
        rate: 1.02,
        availableCents: 250000
      },
      {
        id: "OFR-DEMO-003",
        sellerName: "Demo Seller 3",
        paymentMethod: "VENMO",
        rate: 0.99,
        availableCents: 50000
      }
    ];

    for (const offer of demoOffers) {
      await pool.query(
        `
        INSERT INTO offers
        (
          id,
          seller_name,
          payment_method,
          rate,
          available_cents,
          active,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,TRUE,$6,$6)
        `,
        [
          offer.id,
          offer.sellerName,
          offer.paymentMethod,
          offer.rate,
          offer.availableCents,
          now
        ]
      );
    }
  }
}


function createTradeId() {
  return (
    "TRD-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

/* =========================
   CREATE SELLER OFFER
========================= */

app.post("/api/offers", async function (req, res) {
  try {
    const sellerName = String(req.body.sellerName || "").trim();
    const paymentMethod = String(
      req.body.paymentMethod || ""
    ).toUpperCase();
    const rate = Number(req.body.rate);
    const availableAmount = Number(req.body.availableAmount);

    if (!sellerName || sellerName.length > 80) {
      return res.status(400).json({
        error: "Seller name is required and must be 80 characters or less."
      });
    }

    if (paymentMethod !== "VENMO") {
      return res.status(400).json({
        error: "Unsupported payment method."
      });
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({
        error: "Invalid rate."
      });
    }

    if (
      !Number.isFinite(availableAmount) ||
      availableAmount < 1 ||
      availableAmount > 1000000
    ) {
      return res.status(400).json({
        error: "Available amount must be between $1 and $1,000,000."
      });
    }

    const offerId =
      "OFR-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    const now = new Date();
    const availableCents = Math.round(availableAmount * 100);

    await pool.query(
      `
      INSERT INTO offers
      (
        id,
        seller_name,
        payment_method,
        rate,
        available_cents,
        active,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,TRUE,$6,$6)
      `,
      [
        offerId,
        sellerName,
        paymentMethod,
        rate,
        availableCents,
        now
      ]
    );

    res.json({
      success: true,
      offerId: offerId,
      sellerName: sellerName,
      paymentMethod: paymentMethod,
      rate: rate,
      availableAmount: availableCents / 100
    });

  } catch (error) {
    console.error("Create offer error:", error);

    res.status(500).json({
      error: "Unable to create offer."
    });
  }
});
/* =========================
   MARKETPLACE OFFERS
========================= */

app.get("/api/offers", async function (req, res) {
  try {
    const amount = Number(req.query.amount);
    const paymentMethod = String(
      req.query.paymentMethod || "VENMO"
    ).toUpperCase();

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        error: "Invalid amount."
      });
    }

    if (!["VENMO"].includes(paymentMethod)) {
      return res.status(400).json({
        error: "Unsupported payment method."
      });
    }

    const amountCents = Math.round(amount * 100);

    const result = await pool.query(
      `
      SELECT
        id,
        seller_name,
        payment_method,
        rate,
        available_cents
      FROM offers
      WHERE active = TRUE
        AND payment_method = $1
        AND available_cents >= $2
      ORDER BY rate ASC, created_at ASC
      `,
      [paymentMethod, amountCents]
    );

    res.json({
      offers: result.rows.map(function (offer) {
        return {
          id: offer.id,
          sellerName: offer.seller_name,
          paymentMethod: offer.payment_method,
          rate: Number(offer.rate).toFixed(4),
          availableAmount: offer.available_cents / 100
        };
      })
    });

  } catch (error) {
    console.error("Offers error:", error);

    res.status(500).json({
      error: "Unable to retrieve offers."
    });
  }
});


/* =========================
   CREATE TRADE / INTENT
========================= */

app.post("/api/trades", async function (req, res) {
  const client = await pool.connect();

  try {
    const offerId = String(req.body.offerId || "");
    const amount = Number(req.body.amount);
    const paymentMethod = String(
      req.body.paymentMethod || ""
    ).toUpperCase();

    if (!offerId) {
      return res.status(400).json({
        error: "Offer is required."
      });
    }

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        error: "Invalid amount."
      });
    }

    if (paymentMethod !== "VENMO") {
      return res.status(400).json({
        error: "Unsupported payment method."
      });
    }

    const amountCents = Math.round(amount * 100);

    await client.query("BEGIN");

    const offerResult = await client.query(
      `
      SELECT *
      FROM offers
      WHERE id = $1
        AND active = TRUE
      FOR UPDATE
      `,
      [offerId]
    );

    if (offerResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Offer not found or no longer available."
      });
    }

    const offer = offerResult.rows[0];

    if (offer.payment_method !== paymentMethod) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Payment method does not match the offer."
      });
    }

    if (offer.available_cents < amountCents) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "This offer no longer has enough available amount."
      });
    }

    const tradeId = createTradeId();
    const now = new Date();

    const expiresAt = new Date(
      now.getTime() + 2 * 60 * 60 * 1000
    );

    await client.query(
      `
      UPDATE offers
      SET
        available_cents = available_cents - $1,
        updated_at = $2
      WHERE id = $3
      `,
      [amountCents, now, offerId]
    );

    await client.query(
      `
      INSERT INTO trades
      (
        id,
        offer_id,
        amount_cents,
        payment_method,
        seller_name,
        rate,
        status,
        created_at,
        updated_at,
        expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
      `,
      [
        tradeId,
        offer.id,
        amountCents,
        paymentMethod,
        offer.seller_name,
        offer.rate,
        "PAYMENT_PENDING",
        now,
        expiresAt
      ]
    );

    await client.query("COMMIT");

    res.json({
      tradeId: tradeId,
      amount: amountCents / 100,
      amount_cents: amountCents,
      paymentMethod: paymentMethod,
      sellerName: offer.seller_name,
      rate: Number(offer.rate),
      status: "PAYMENT_PENDING",
      expiresAt: expiresAt.toISOString()
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("Create trade error:", error);

    res.status(500).json({
      error: "Unable to create trade."
    });

  } finally {
    client.release();
  }
});


/* =========================
   GET TRADE
========================= */

app.get("/api/trades/:id", async function (req, res) {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM trades
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Trade not found."
      });
    }

    const trade = result.rows[0];

    if (
      trade.status === "PAYMENT_PENDING" &&
      new Date(trade.expires_at).getTime() <= Date.now()
    ) {
      const now = new Date();

      await pool.query(
        `
        UPDATE trades
        SET status = $1, updated_at = $2
        WHERE id = $3
        `,
        ["EXPIRED", now, trade.id]
      );

      await pool.query(
        `
        UPDATE offers
        SET
          available_cents = available_cents + $1,
          updated_at = $2
        WHERE id = $3
        `,
        [trade.amount_cents, now, trade.offer_id]
      );

      trade.status = "EXPIRED";
      trade.updated_at = now;
    }

    res.json({
      id: trade.id,
      offerId: trade.offer_id,
      amount: trade.amount_cents / 100,
      amount_cents: trade.amount_cents,
      paymentMethod: trade.payment_method,
      sellerName: trade.seller_name,
      rate: Number(trade.rate),
      status: trade.status,
      createdAt: new Date(trade.created_at).toISOString(),
      updatedAt: new Date(trade.updated_at).toISOString(),
      expiresAt: new Date(trade.expires_at).toISOString()
    });

  } catch (error) {
    console.error("Get trade error:", error);

    res.status(500).json({
      error: "Unable to retrieve trade."
    });
  }
});


/* =========================
   TRADE PAYMENT SUBMITTED
========================= */

app.post("/api/trades/:id/payment-submitted", async function (req, res) {
  try {
    const result = await pool.query(
      "SELECT * FROM trades WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Trade not found."
      });
    }

    const trade = result.rows[0];

    if (
      trade.status === "PAYMENT_PENDING" &&
      new Date(trade.expires_at).getTime() <= Date.now()
    ) {
      return res.status(400).json({
        error: "This trade has expired."
      });
    }

    if (trade.status !== "PAYMENT_PENDING") {
      return res.status(400).json({
        error: "Trade is already " + trade.status + "."
      });
    }

    const now = new Date();

    await pool.query(
      `
      UPDATE trades
      SET
        status = $1,
        updated_at = $2
      WHERE id = $3
      `,
      [
        "VERIFICATION_PENDING",
        now,
        trade.id
      ]
    );

    res.json({
      id: trade.id,
      status: "VERIFICATION_PENDING"
    });

  } catch (error) {
    console.error("Trade payment submission error:", error);

    res.status(500).json({
      error: "Unable to update trade."
    });
  }
});
/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    await initializeDatabase();
await initializeMarketplaceDatabase();

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