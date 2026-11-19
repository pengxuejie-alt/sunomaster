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
  name: "Hamlet (e-book)",
  tax_code: "txcd_10103100",
  default_price_data: {
    currency: "usd",
    unit_amount: 1000,
  },
  expand: ["default_price"],
}, {
  idempotencyKey: "hamlet-ebook-usd-1000-txcd_10103100",
  apiVersion: "2026-02-25.preview",
});
const price = typeof product.default_price === "string" ? product.default_price : product.default_price.id;
const keyLine = `STRIPE_EBOOK_PRICE_ID=${price}`;
const nextEnv = /^STRIPE_EBOOK_PRICE_ID=/m.test(envText)
  ? envText.replace(/^STRIPE_EBOOK_PRICE_ID=.*$/m, keyLine)
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
  ebookProductId: product.id,
  ebookPriceId: price,
};
fs.mkdirSync(path.dirname(storeFile), { recursive: true });
fs.writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`);

const session = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ price, quantity: 1 }],
  managed_payments: { enabled: true },
  billing_address_collection: "required",
  success_url: "https://sunomaster.xyz/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://sunomaster.xyz/?checkout=cancelled",
}, { apiVersion: "2026-02-25.preview" });
fs.writeFileSync(path.join(root, "tools", "_ebook_checkout_url.txt"), session.url);
console.log(JSON.stringify({
  product: product.id,
  price,
  taxCode: product.tax_code,
  amount: 1000,
  currency: "usd",
  session: session.id,
  managed: session.managed_payments,
}));
