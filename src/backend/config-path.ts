import path from "node:path";
import { app } from "electron";
import { CONFIG_FILE_NAME } from "./db-config";

/** Location of config.json in the per-user data folder (no database access: safe to import before the app is ready). */
export const configFilePath = (): string => path.join(app.getPath("userData"), CONFIG_FILE_NAME);
