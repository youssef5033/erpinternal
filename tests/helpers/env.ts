import { config } from "dotenv";
config({ path: ".env.test", override: true });
process.env.STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR_TEST ?? "./storage-test";
