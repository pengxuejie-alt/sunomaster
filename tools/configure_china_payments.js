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
if (!process.env.STRIPE_CREDITS_PRICE_ID) throw new Error("STRIPE_CREDITS_PRICE_ID is missing from .env");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createHkdPrice(sourcePriceId, label, metadataValue) {
  if (!sourcePriceId) return null;
  const sourcePrice = await stripe.prices.retrieve(sourcePriceId);
  if (sourcePrice.type !== "one_time" || !sourcePrice.unit_amount) {
    throw new Error(`${label} must use a fixed one-time Price`);
  }
  const productId = typeof sourcePrice.product === "string"
    ? sourcePrice.product
    : sourcePrice.product.id;
  const hkdAmount = sourcePrice.currency === "hkd"
    ? sourcePrice.unit_amount
    : Math.max(400, Math.round((sourcePrice.unit_amount / 100) * 7.8) * 100);
  return stripe.prices.create({
    product: productId,
    currency: "hkd",
    unit_amount: hkdAmount,
    nickname: `${label} — Hong Kong / China wallets`,
    tax_behavior: "unspecified",
    metadata: {
      sunomaster_price: metadataValue,
      supports_china_wallets: "true",
    },
  }, { idempotencyKey: `sunomaster-${metadataValue}-hkd-${hkdAmount}-v1` });
}

const hkdCreditsPrice = await createHkdPrice(
  process.env.STRIPE_CREDITS_PRICE_ID,
  "100 credits",
  "credits_100_hkd",
);
let hkdEbookPrice = null;
let ebookWarning = "";
try {
  hkdEbookPrice = await createHkdPrice(
    process.env.STRIPE_EBOOK_PRICE_ID,
    "SunoMaster ebook",
    "ebook_hkd",
  );
} catch (error) {
  if (error?.code !== "resource_missing") throw error;
  ebookWarning = "STRIPE_EBOOK_PRICE_ID belongs to a different Stripe account and was left unchanged.";
}

const configurations = await stripe.paymentMethodConfigurations.list({ limit: 100 });
const updatedConfigurations = [];
for (const configuration of configurations.data.filter((item) => item.active)) {
  const updated = await stripe.paymentMethodConfigurations.update(configuration.id, {
    link: { display_preference: { preference: "off" } },
    alipay: { display_preference: { preference: "on" } },
    wechat_pay: { display_preference: { preference: "on" } },
  });
  updatedConfigurations.push({
    id: updated.id,
    link: updated.link?.available,
    alipay: updated.alipay?.available,
    wechatPay: updated.wechat_pay?.available,
  });
}

function setEnv(name, value, afterName) {
  if (!value) return;
  const setting = `${name}=${value}`;
  if (new RegExp(`^${name}=.*$`, "m").test(envText)) {
    envText = envText.replace(new RegExp(`^${name}=.*$`, "m"), setting);
    return;
  }
  envText = envText.replace(
    new RegExp(`^${afterName}=.*$`, "m"),
    (line) => `${line}\n${setting}`,
  );
}
setEnv("STRIPE_CREDITS_PRICE_ID_HKD", hkdCreditsPrice?.id, "STRIPE_CREDITS_PRICE_ID");
setEnv("STRIPE_EBOOK_PRICE_ID_HKD", hkdEbookPrice?.id, "STRIPE_EBOOK_PRICE_ID");
fs.writeFileSync(envFile, envText);

const account = await stripe.accounts.retrieve();
console.log(JSON.stringify({
  account: account.id,
  country: account.country,
  hkdCreditsPrice: hkdCreditsPrice?.id,
  hkdEbookPrice: hkdEbookPrice?.id,
  ebookWarning,
  paymentMethodConfigurations: updatedConfigurations,
}, null, 2));
