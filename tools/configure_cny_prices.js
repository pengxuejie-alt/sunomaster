import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
let envText = fs.readFileSync(envFile, "utf8");

for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is missing from .env");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sources = [
  ["STRIPE_CREDITS_PRICE_ID", "STRIPE_CREDITS_PRICE_ID_CNY", "credits_100_cny", "100 credits"],
  ["STRIPE_VIP_BASIC_MONTHLY_PRICE_ID", "STRIPE_VIP_BASIC_MONTHLY_PRICE_ID_CNY", "vip_basic_month_cny", "Basic one month"],
  ["STRIPE_VIP_BASIC_YEARLY_PRICE_ID", "STRIPE_VIP_BASIC_YEARLY_PRICE_ID_CNY", "vip_basic_year_cny", "Basic one year"],
  ["STRIPE_VIP_PRO_MONTHLY_PRICE_ID", "STRIPE_VIP_PRO_MONTHLY_PRICE_ID_CNY", "vip_pro_month_cny", "Pro one month"],
  ["STRIPE_VIP_PRO_YEARLY_PRICE_ID", "STRIPE_VIP_PRO_YEARLY_PRICE_ID_CNY", "vip_pro_year_cny", "Pro one year"],
  ["STRIPE_VIP_MAX_MONTHLY_PRICE_ID", "STRIPE_VIP_MAX_MONTHLY_PRICE_ID_CNY", "vip_max_month_cny", "Max one month"],
  ["STRIPE_VIP_MAX_YEARLY_PRICE_ID", "STRIPE_VIP_MAX_YEARLY_PRICE_ID_CNY", "vip_max_year_cny", "Max one year"],
];

let rate = 7.2;
try {
  const response = await fetch("https://open.er-api.com/v6/latest/USD");
  const data = await response.json();
  if (Number(data?.rates?.CNY) > 0) rate = Number(data.rates.CNY);
} catch { /* use the fallback rate */ }

function setEnv(name, value, afterName) {
  if (!value) return;
  const setting = `${name}=${value}`;
  if (new RegExp(`^${name}=.*$`, "m").test(envText)) {
    envText = envText.replace(new RegExp(`^${name}=.*$`, "m"), setting);
    return;
  }
  if (new RegExp(`^${afterName}=.*$`, "m").test(envText)) {
    envText = envText.replace(new RegExp(`^${afterName}=.*$`, "m"), (line) => `${line}\n${setting}`);
    return;
  }
  envText += `${envText.endsWith("\n") ? "" : "\n"}${setting}\n`;
}

const created = [];
let creditsPriceId = "";
for (const [sourceName, targetName, metadataValue, label] of sources) {
  const sourcePrice = await stripe.prices.retrieve(process.env[sourceName]);
  if (!sourcePrice.unit_amount || sourcePrice.currency !== "usd") {
    throw new Error(`${sourceName} must be a fixed USD price`);
  }
  const productId = typeof sourcePrice.product === "string" ? sourcePrice.product : sourcePrice.product.id;
  const cnyAmount = Math.max(100, Math.round((sourcePrice.unit_amount / 100) * rate) * 100);
  const price = await stripe.prices.create({
    product: productId,
    currency: "cny",
    unit_amount: cnyAmount,
    nickname: `${label} — CNY / WeChat Pay`,
    tax_behavior: "unspecified",
    metadata: { sunomaster_price: metadataValue, supports_wechat_pay: "true" },
  }, { idempotencyKey: `sunomaster-${metadataValue}-cny-v1` });
  setEnv(targetName, price.id, sourceName);
  if (targetName === "STRIPE_CREDITS_PRICE_ID_CNY") creditsPriceId = price.id;
  created.push({ label, cny: cnyAmount / 100, usd: sourcePrice.unit_amount / 100 });
}

fs.writeFileSync(envFile, envText);

const session = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ price: creditsPriceId, quantity: 1 }],
  payment_method_options: { wechat_pay: { client: "web" } },
  wallet_options: { link: { display: "never" } },
  managed_payments: { enabled: false },
  success_url: "https://sunomaster.xyz/account?checkout=success",
  cancel_url: "https://sunomaster.xyz/account?checkout=cancelled",
});
let forced = null;
try {
  const explicit = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: creditsPriceId, quantity: 1 }],
    payment_method_types: ["card", "wechat_pay"],
    payment_method_options: { wechat_pay: { client: "web" } },
    wallet_options: { link: { display: "never" } },
    managed_payments: { enabled: false },
    success_url: "https://sunomaster.xyz/account?checkout=success",
    cancel_url: "https://sunomaster.xyz/account?checkout=cancelled",
  });
  forced = { methods: explicit.payment_method_types };
  await stripe.checkout.sessions.expire(explicit.id);
} catch (error) {
  forced = { error: error.message };
}
await stripe.checkout.sessions.expire(session.id);

console.log(JSON.stringify({
  rate: Number(rate.toFixed(4)),
  prices: created,
  checkout: {
    currency: session.currency,
    amount: session.amount_total,
    methods: session.payment_method_types,
    link: session.wallet_options?.link?.display || "",
  },
  forced,
}, null, 2));
