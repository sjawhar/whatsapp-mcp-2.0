import path from "path";
import os from "os";

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");

export const DATA_DIR = path.join(dataHome, "whatsapp-mcp");
export const STORE_DIR = path.join(DATA_DIR, "store");
export const AUTH_DIR = path.join(DATA_DIR, "auth_info");
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
export const CONTACTS_DIR = path.join(DATA_DIR, "contacts");
export const LOCK_FILE = path.join(STORE_DIR, ".whatsapp.lock");
