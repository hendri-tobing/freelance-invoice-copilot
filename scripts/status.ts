// Read-only status check for an existing sandbox invoice ID.
import { loadConfig, PayPalClient } from "../src/paypal.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npm run status -- <invoice_id>");
  process.exit(1);
}
new PayPalClient(loadConfig())
  .getInvoice(id)
  .then((inv) => console.log(JSON.stringify(inv, null, 2)))
  .catch((e) => {
    console.error("STATUS FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
