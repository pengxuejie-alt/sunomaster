import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const envText = fs.readFileSync(envFile, "utf8");

for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is missing from .env");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const creditsProduct = await stripe.products.create({
  name: "Sunomaster 100 Credits",
  description: "One-time purchase of 100 credits for Sunomaster creative writing and music workflow tools.",
  metadata: { sunomaster_product: "credits_100" },
  default_price_data: {
    currency: "usd",
    unit_amount: 999,
    tax_behavior: "unspecified",
    metadata: { sunomaster_price: "credits_100" },
  },
  expand: ["default_price"],
}, { idempotencyKey: "sunomaster-credits-100-usd-999-v1" });

const proProduct = await stripe.products.create({
  name: "Sunomaster Pro",
  description: "Monthly access to Sunomaster creative writing, lyric drafting, prompt formatting, and trend research software.",
  statement_descriptor: "SUNOMASTER",
  metadata: { sunomaster_product: "pro_monthly" },
  default_price_data: {
    currency: "usd",
    unit_amount: 1999,
    tax_behavior: "unspecified",
    recurring: { interval: "month", interval_count: 1 },
    metadata: { sunomaster_price: "pro_monthly" },
  },
  expand: ["default_price"],
}, { idempotencyKey: "sunomaster-pro-monthly-usd-1999-v1" });

const creditsPrice = typeof creditsProduct.default_price === "string"
  ? creditsProduct.default_price
  : creditsProduct.default_price.id;
const subscriptionPrice = typeof proProduct.default_price === "string"
  ? proProduct.default_price
  : proProduct.default_price.id;

const nextEnv = envText
  .replace(/^STRIPE_CREDITS_PRICE_ID=.*$/m, `STRIPE_CREDITS_PRICE_ID=${creditsPrice}`)
  .replace(/^STRIPE_SUBSCRIPTION_PRICE_ID=.*$/m, `STRIPE_SUBSCRIPTION_PRICE_ID=${subscriptionPrice}`);
fs.writeFileSync(envFile, nextEnv);

const account = await stripe.accounts.retrieve();
console.log(JSON.stringify({
  account: account.id,
  creditsProduct: creditsProduct.id,
  creditsPrice,
  proProduct: proProduct.id,
  subscriptionPrice,
}, null, 2));
