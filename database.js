// Import SQLite database library
const Database = require("better-sqlite3");

// Create or open the local database
const db = new Database("products.db");

// Create products table if it does not exist
db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL CHECK(price >= 0),
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0)
    )
`);
// Create users table to store registered accounts
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);
// Store single-use password reset tokens
db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Add created_at column to older databases if missing
const columns = db.prepare(
    "PRAGMA table_info(password_resets)"
).all();

const hasCreatedAt = columns.some(
    column => column.name === "created_at"
);

if (!hasCreatedAt) {
    db.exec(`
        ALTER TABLE password_resets
        ADD COLUMN created_at INTEGER
    `);
}

// Additive migration: preserve all existing users, hashes, IDs and products.
// Immediate transaction serializes concurrent startup migrations. Re-runs are safe.
db.transaction(() => {
    const userColumns = db.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some(column => column.name === "token_version")) {
        db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
    }
}).immediate();

// Export the database connection
module.exports = db;
