import crypto from "crypto";
import fs from "fs";
import path from "path";
import Stripe from "stripe";

const CUSTOMER_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyStore() {
  return { customers: {}, customerIndex: {}, payments: {}, events: [] };
}

function readStore(file) {
  try {
    return { ...emptyStore(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return emptyStore();
  }
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  return configured || `${req.protocol}://${req.get("host")}`;
}

function stripeId(value) {
  return typeof value === "string" ? value : value?.id || "";
}

const VIP_PLANS = {
  basic: { credits: 4000, month: "STRIPE_VIP_BASIC_MONTHLY_PRICE_ID", year: "STRIPE_VIP_BASIC_YEARLY_PRICE_ID" },
  pro: { credits: 10000, month: "STRIPE_VIP_PRO_MONTHLY_PRICE_ID", year: "STRIPE_VIP_PRO_YEARLY_PRICE_ID" },
  max: { credits: 50000, month: "STRIPE_VIP_MAX_MONTHLY_PRICE_ID", year: "STRIPE_VIP_MAX_YEARLY_PRICE_ID" },
};

function creditPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function refreshPlanCredits(record) {
  if (record?.subscriptionStatus !== "active" || !record.planCredits) return false;
  const period = creditPeriod();
  if (record.creditPeriod === period) return false;
  record.credits = record.planCredits;
  record.creditPeriod = period;
  return true;
}

function lapsePrepaid(record, now = new Date()) {
  if (record?.billingSource !== "prepaid" || !record.accessUntil) return false;
  if (new Date(record.accessUntil).getTime() > now.getTime()) return false;
  record.subscriptionStatus = "canceled";
  return true;
}

function grantPrepaidPlan(record, plan, interval) {
  const end = new Date();
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  record.plan = plan;
  record.billingInterval = interval;
  record.planCredits = VIP_PLANS[plan].credits;
  record.credits = record.planCredits;
  record.creditPeriod = creditPeriod();
  record.subscriptionStatus = "active";
  record.billingSource = "prepaid";
  record.accessUntil = end.toISOString();
  record.subscriptionId = "";
}

export function createBilling(rootDir) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const stripe = secretKey ? new Stripe(secretKey) : null;
  const livemode = /^(sk|rk)_live_/.test(secretKey || "");
  const priceCache = new Map();
  const storeFile = path.join(rootDir, "data", "billing.json");

  function requireStripe(res) {
    if (stripe) return true;
    res.status(503).json({ error: "Stripe is not configured on this server." });
    return false;
  }

  function accountRef(req) {
    const value = String(req.account?.id || "").trim().toLowerCase();
    return CUSTOMER_REF.test(value) ? value : "";
  }

  async function getOrCreateCustomer(ref, store, profile = {}) {
    const saved = store.customers[ref];
    if (saved?.customerId) return saved.customerId;
    const customer = await stripe.customers.create({
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { name: profile.name } : {}),
      metadata: { sunomaster_customer_ref: ref },
    }, { idempotencyKey: `sunomaster-customer-${ref}` });
    store.customers[ref] = { credits: 50, customerId: customer.id, subscriptionStatus: "none" };
    store.customerIndex[customer.id] = ref;
    writeStore(storeFile, store);
    return customer.id;
  }

  function refForCustomer(store, customer) {
    return store.customerIndex[stripeId(customer)] || "";
  }

  function applyEvent(event) {
    const store = readStore(storeFile);
    if (store.events.includes(event.id)) return;

    const object = event.data.object;
    const metadataRef = String(object?.metadata?.sunomaster_customer_ref || "").toLowerCase();
    const ref = CUSTOMER_REF.test(metadataRef) ? metadataRef : refForCustomer(store, object?.customer);

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (ref) {
        const record = store.customers[ref] || { credits: 50, subscriptionStatus: "none" };
        record.customerId = stripeId(object.customer) || record.customerId;
        store.customerIndex[record.customerId] = ref;
        if (object.mode === "payment" && object.payment_status === "paid") {
          record.checkoutSessionId = object.id;
          record.managedPayments = object.managed_payments?.enabled === true;
          const paymentIntent = stripeId(object.payment_intent);
          const purchaseKind = object.metadata?.purchase_kind || "payment";
          if (paymentIntent && !store.payments[paymentIntent]) {
            const credits = Math.max(0, Number(object.metadata?.credits || 0));
            if (purchaseKind === "plan") {
              const plan = VIP_PLANS[object.metadata?.plan] ? object.metadata.plan : "";
              if (plan) grantPrepaidPlan(record, plan, object.metadata?.interval === "year" ? "year" : "month");
            } else {
              record.credits += credits;
            }
            store.payments[paymentIntent] = {
              ref,
              credits,
              refunded: false,
              purchaseKind,
              checkoutSessionId: object.id,
            };
          }
        }
        if (object.mode === "subscription") {
          record.checkoutSessionId = object.id;
          record.subscriptionId = stripeId(object.subscription);
          record.subscriptionStatus = "active";
          record.managedPayments = object.managed_payments?.enabled === true;
          const plan = VIP_PLANS[object.metadata?.plan] ? object.metadata.plan : "";
          if (plan) {
            record.plan = plan;
            record.billingInterval = object.metadata?.interval === "year" ? "year" : "month";
            record.planCredits = VIP_PLANS[plan].credits;
            record.credits = record.planCredits;
            record.creditPeriod = creditPeriod();
          }
        }
        store.customers[ref] = record;
      }
    } else if (event.type === "invoice.paid" && ref) {
      const record = store.customers[ref];
      record.subscriptionStatus = "active";
      refreshPlanCredits(record);
    } else if (event.type === "invoice.payment_failed" && ref) {
      store.customers[ref].subscriptionStatus = "past_due";
    } else if (event.type === "customer.subscription.updated" && ref) {
      store.customers[ref].subscriptionId = object.id;
      store.customers[ref].subscriptionStatus = object.status;
    } else if (event.type === "customer.subscription.deleted" && ref) {
      store.customers[ref].subscriptionStatus = "canceled";
    } else if (event.type === "charge.refunded") {
      const payment = store.payments[stripeId(object.payment_intent)];
      if (payment && !payment.refunded && object.amount_refunded >= object.amount) {
        const record = store.customers[payment.ref];
        if (record) {
          record.credits = Math.max(0, record.credits - payment.credits);
          if (payment.purchaseKind === "plan" && record.billingSource === "prepaid") {
            record.subscriptionStatus = "canceled";
            record.accessUntil = new Date().toISOString();
          }
        }
        payment.refunded = true;
      }
    }

    store.events.push(event.id);
    if (store.events.length > 500) store.events.splice(0, store.events.length - 500);
    writeStore(storeFile, store);
  }

  async function webhook(req, res) {
    if (!requireStripe(res)) return;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(503).send("Stripe webhook secret is not configured.");
    try {
      const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
      applyEvent(event);
      res.json({ received: true });
    } catch (error) {
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }

  async function checkout(req, res) {
    if (!requireStripe(res)) return;
    const ref = accountRef(req);
    const kind = ["subscription", "ebook"].includes(req.body?.kind) ? req.body.kind : "credits";
    if (!ref) return res.status(401).json({ error: "请先登录" });

    const plan = VIP_PLANS[req.body?.plan] ? req.body.plan : "";
    const interval = req.body?.interval === "year" ? "year" : "month";
    const prepaidPlan = kind === "subscription" && Boolean(plan);
    const usdPriceId = prepaidPlan
      ? process.env[VIP_PLANS[plan][interval]]
      : kind === "ebook"
        ? process.env.STRIPE_EBOOK_PRICE_ID
        : process.env.STRIPE_CREDITS_PRICE_ID;
    if (!usdPriceId) return res.status(503).json({ error: "这个价格还没配好，暂时不能付款。" });

    try {
      const store = readStore(storeFile);
      const customer = await getOrCreateCustomer(ref, store, req.account || {});
      const baseUrl = publicBaseUrl(req);
      const metadata = {
        sunomaster_customer_ref: ref,
        purchase_kind: prepaidPlan ? "plan" : kind,
        currency: "usd",
        ...(kind === "credits" ? { credits: "100" } : {}),
        ...(plan ? { plan, interval, credits: String(VIP_PLANS[plan].credits) } : {}),
      };
      const source = await stripe.prices.retrieve(usdPriceId);
      const product = typeof source.product === "string" ? source.product : source.product.id;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer,
        client_reference_id: ref,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: source.unit_amount,
            product,
          },
        }],
        adaptive_pricing: { enabled: true },
        metadata,
        locale: "zh",
        wallet_options: { link: { display: "never" } },
        ...(kind === "ebook" ? {} : { payment_method_options: { wechat_pay: { client: "web" }, alipay: {} } }),
        managed_payments: { enabled: false },
        success_url: `${baseUrl}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/account?checkout=cancelled`,
        ...(kind === "credits" ? { invoice_creation: { enabled: true } } : {}),
      }, {
        idempotencyKey: crypto.randomUUID(),
      });
      res.json({ url: session.url });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Could not create Checkout." });
    }
  }

  async function portal(req, res) {
    if (!requireStripe(res)) return;
    const ref = accountRef(req);
    if (!ref) return res.status(401).json({ error: "请先登录" });
    const record = readStore(storeFile).customers[ref];
    if (!record?.customerId) return res.status(404).json({ error: "还没有可管理的账单" });
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: record.customerId,
        return_url: `${publicBaseUrl(req)}/account`,
      });
      res.json({ url: session.url });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Could not open billing portal." });
    }
  }

  async function readPrice(id) {
    if (!stripe || !id) return null;
    const hit = priceCache.get(id);
    if (hit && hit.expires > Date.now()) return hit.price;
    try {
      const price = await stripe.prices.retrieve(id);
      const brief = price.active ? { unit_amount: price.unit_amount, currency: price.currency } : null;
      priceCache.set(id, { price: brief, expires: Date.now() + 5 * 60 * 1000 });
      return brief;
    } catch {
      return null;
    }
  }

  async function catalog(_req, res) {
    const plans = [];
    for (const id of Object.keys(VIP_PLANS)) {
      const month = await readPrice(process.env[VIP_PLANS[id].month]);
      const year = await readPrice(process.env[VIP_PLANS[id].year]);
      plans.push({
        id,
        credits: VIP_PLANS[id].credits,
        month: month?.unit_amount || 0,
        year: year?.unit_amount || 0,
        currency: month?.currency || year?.currency || "usd",
        ready: Boolean(month?.unit_amount && year?.unit_amount),
      });
    }
    const creditsPrice = await readPrice(process.env.STRIPE_CREDITS_PRICE_ID);
    const creditsCny = await readPrice(process.env.STRIPE_CREDITS_PRICE_ID_CNY);
    for (const plan of plans) {
      const monthCny = await readPrice(process.env[`${VIP_PLANS[plan.id].month}_CNY`]);
      const yearCny = await readPrice(process.env[`${VIP_PLANS[plan.id].year}_CNY`]);
      plan.cny = {
        month: monthCny?.unit_amount || 0,
        year: yearCny?.unit_amount || 0,
        currency: "cny",
        ready: Boolean(monthCny?.unit_amount && yearCny?.unit_amount),
      };
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      livemode,
      credits: {
        credits: 100,
        amount: creditsPrice?.unit_amount || 0,
        currency: creditsPrice?.currency || "usd",
        ready: Boolean(creditsPrice?.unit_amount),
        cny: {
          amount: creditsCny?.unit_amount || 0,
          currency: "cny",
          ready: Boolean(creditsCny?.unit_amount),
        },
      },
      plans,
    });
  }

  function status(req, res) {
    const ref = accountRef(req);
    if (!ref) return res.status(401).json({ error: "请先登录" });
    const store = readStore(storeFile);
    const record = store.customers[ref] || { credits: 50, subscriptionStatus: "none" };
    const changed = lapsePrepaid(record) || refreshPlanCredits(record);
    if (changed) {
      store.customers[ref] = record;
      writeStore(storeFile, store);
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      credits: record.credits,
      subscriptionStatus: record.subscriptionStatus,
      plan: record.plan || "",
      billingInterval: record.billingInterval || "",
      billingSource: record.billingSource || (record.subscriptionId ? "stripe" : ""),
      accessUntil: record.accessUntil || "",
    });
  }

  async function createInvoice(req, res) {
    if (!requireStripe(res)) return;
    const expected = process.env.INVOICE_ADMIN_TOKEN;
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!expected || supplied !== expected) return res.status(401).json({ error: "Unauthorized." });

    const email = String(req.body?.email || "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const idempotencyKey = String(req.body?.idempotencyKey || "").trim();
    if (!email || !items.length || !idempotencyKey) {
      return res.status(400).json({ error: "email, items, and idempotencyKey are required." });
    }
    try {
      const customer = await stripe.customers.create({ email }, {
        idempotencyKey: `${idempotencyKey}-customer`,
      });
      for (const [index, item] of items.entries()) {
        await stripe.invoiceItems.create({
          customer: customer.id,
          currency: String(item.currency || "usd").toLowerCase(),
          unit_amount_decimal: String(item.amount),
          quantity: Math.max(1, Number(item.quantity || 1)),
          description: String(item.description || "Sunomaster service"),
        }, { idempotencyKey: `${idempotencyKey}-item-${index}` });
      }
      const invoice = await stripe.invoices.create({
        customer: customer.id,
        collection_method: "send_invoice",
        days_until_due: Math.max(1, Number(req.body?.dueDays || 14)),
        auto_advance: true,
        metadata: { sunomaster_invoice_key: idempotencyKey },
      }, { idempotencyKey });
      res.json({ id: invoice.id, status: invoice.status, hostedInvoiceUrl: invoice.hosted_invoice_url });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Could not create invoice." });
    }
  }

  return { webhook, checkout, portal, status, catalog, createInvoice };
}
