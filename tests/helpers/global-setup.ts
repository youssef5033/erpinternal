import { config } from "dotenv";
import { execSync } from "node:child_process";

export default function setup() {
  config({ path: ".env.test", override: true });
  if (!process.env.DATABASE_URL?.includes("test")) throw new Error("Refusing to run tests against a non-test database (DATABASE_URL must contain 'test').");
  execSync("npx drizzle-kit migrate", { stdio: "inherit", env: process.env });
}
