import { createDb } from "../service/db";
import { createApp } from "./app";

const sql = await createDb();
const app = createApp(sql);
const port = Number(process.env.WEB_PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};

console.error(`Polaris web app listening on http://localhost:${port}`);
