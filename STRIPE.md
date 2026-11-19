# Stripe integration

This project uses Stripe-hosted Checkout for one-time credit purchases and monthly
subscriptions, Customer Portal for self-service billing, signed webhooks for
entitlements, and the Invoicing API for admin-created invoices.

## Test products

- Sunomaster 100 Credits: USD $9.99 one-time
- Sunomaster Pro: USD $19.99 monthly

## China payment methods

Membership checkout opens Stripe-hosted Checkout in a new window. Prices on the
account page stay in USD. Adaptive Pricing lets the Stripe page offer USD and
CNY, which is what makes WeChat Pay eligible. Alipay appears only after Stripe
marks it available on the account. After payment, the original membership page
reloads.

Run `node tools/setup_stripe.js` to create or retrieve the test products in the
account associated with `STRIPE_SECRET_KEY` and update their Price IDs in `.env`.

## Local development

1. Copy `.env.example` to `.env` and set test keys and Price IDs.
2. Start the app with `npm start`.
3. In another terminal, forward the required webhook events:

   `stripe listen --events "checkout.session.completed,checkout.session.async_payment_succeeded,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded" --forward-to http://127.0.0.1:3800/api/stripe/webhook`

4. Put the printed `whsec_...` value in `STRIPE_WEBHOOK_SECRET`, then restart the app.
5. Use Stripe test card `4242 4242 4242 4242`, any future expiry, and any CVC.

## Standalone invoices

Set a long random `INVOICE_ADMIN_TOKEN`. Then call `POST /api/stripe/invoices`
with `Authorization: Bearer <token>` and JSON like:

```json
{
  "email": "customer@example.com",
  "idempotencyKey": "invoice-order-123",
  "dueDays": 14,
  "items": [
    {
      "description": "Sunomaster annual service",
      "currency": "usd",
      "amount": 19999,
      "quantity": 1
    }
  ]
}
```

Amounts use the currency's smallest unit. Stripe emails the hosted invoice page
after automatic finalization.

## Before production

- Add real user authentication and store Stripe customer/subscription IDs in the
  application database. The current browser UUID mapping is suitable only for a
  test integration.
- Enforce credits and subscription access on server-side product endpoints. The
  existing app still deducts usage in the browser and can be bypassed.
- Replace all test keys and Price IDs with live values; never expose the secret key.
- Create a Dashboard webhook endpoint for `https://sunomaster.xyz/api/stripe/webhook`.
- Set `PUBLIC_URL=https://sunomaster.xyz`, use a strong invoice admin token, and
  configure Customer Portal, Smart Retries, failed-payment emails, branding, and
  cancellation behavior.
- Keep Stripe Tax in threshold-monitoring mode until a tax registration is
  required. Then configure registrations/product tax codes and enable automatic tax.
- Publish terms, privacy, refund/cancellation, and support contact pages, and make
  the Suno non-affiliation statement visible at Checkout and on the website.
