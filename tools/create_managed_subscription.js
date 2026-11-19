import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const envText = fs.readFileSync(envFile, "utf8");
for (const line of envText.split(/\r?\n/)) {
  const index = line.indexOf("=");
  if (index < 1 || line.startsWith("#")) continue;
  const key = line.slice(0, index);
  if (!process.env[key]) process.env[key] = line.slice(index + 1);
}

if (!process.env.STRIPE_SECRET_KEY) throw new Error("Set STRIPE_SECRET_KEY in .env from the Stripe Dashboard.");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const product = await stripe.products.create({
  name: "Basic subscription",
  tax_code: "txcd_10103100",
  default_price_data: {
    currency: "usd",
    unit_amount: 1000,
    recurring: { interval: "month" },
  },
  expand: ["default_price"],
}, {
  idempotencyKey: "basic-subscription-usd-1000-month-txcd_10103100",
  apiVersion: "2026-02-25.preview",
});
const price = typeof product.default_price === "string" ? product.default_price : product.default_price.id;
const keyLine = `STRIPE_MANAGED_SUBSCRIPTION_PRICE_ID=${price}`;
const nextEnv = /^STRIPE_MANAGED_SUBSCRIPTION_PRICE_ID=/m.test(envText)
  ? envText.replace(/^STRIPE_MANAGED_SUBSCRIPTION_PRICE_ID=.*$/m, keyLine)
  : `${envText.replace(/\s*$/, "")}\n${keyLine}\n`;
fs.writeFileSync(envFile, nextEnv);

const storeFile = path.join(root, "data", "billing.json");
let store = {};
try {
  store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
} catch {
  store = {};
}
store.catalog = {
  ...(store.catalog || {}),
  managedProductId: product.id,
  managedPriceId: price,
};
fs.mkdirSync(path.dirname(storeFile), { recursive: true });
fs.writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`);
console.log(JSON.stringify({ product: product.id, price, taxCode: product.tax_code, amount: 1000, currency: "usd", interval: "month" }));
