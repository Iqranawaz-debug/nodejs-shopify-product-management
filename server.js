// ---------- Imports ----------
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("./database");
// Import Shopify GraphQL connection
const { shopifyGraphQL, ShopifyError } = require("./shopify");
const { logRequest, createAuthRateLimiter } = require("./request-security");

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

// Ensure a secure JWT secret is configured
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("A secure JWT_SECRET must be configured in .env");
}

// ========================================
// SHARED HELPERS
// ========================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt ignores anything beyond 72 bytes
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Used to keep login timing the same when the email doesn't exist
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

// One place for every error response
const sendError = (res, status, message) =>
    res.status(status).json({ success: false, message });

const isValidEmail = (email) =>
    typeof email === "string" &&
    email.trim().length <= 254 &&
    EMAIL_REGEX.test(email.trim());

const normalizeEmail = (email) => email.trim().toLowerCase();

const isValidPassword = (password) =>
    typeof password === "string" &&
    password.length >= PASSWORD_MIN &&
    Buffer.byteLength(password, "utf8") <= PASSWORD_MAX;

const PASSWORD_MESSAGE = `Password must contain ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;

const sha256 = (value) =>
    crypto.createHash("sha256").update(value).digest("hex");

// Reusable product lookup
const findProductById = (id) =>
    db.prepare("SELECT * FROM products WHERE id = ?").get(id);

// ========================================
// MIDDLEWARE
// ========================================

// Log every request, including parser errors and throttled requests.
app.use(logRequest);
app.use("/auth", createAuthRateLimiter());
app.use(express.json({ limit: "10kb" }));

// Handle body-parser errors (invalid JSON, payload too large)
app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
        return sendError(res, 400, "Invalid JSON format");
    }
    if (err.type === "entity.too.large") {
        return sendError(res, 413, "Request body too large");
    }
    next(err);
});

// ========================================
// PRODUCT VALIDATION
// ========================================

// Validate product fields before saving (returns an error string or null)
function validateProduct(product) {
    if (!product || typeof product !== "object" || Array.isArray(product)) {
        return "A valid product object is required";
    }

    const { name, description, price, stock } = product;

    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
        return "Product name is required (max 200 characters)";
    }

    if (
        description !== undefined &&
        (typeof description !== "string" || description.length > 2000)
    ) {
        return "Description must be a string (max 2000 characters)";
    }

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
        return "Price must be a valid non-negative number";
    }

    if (!Number.isSafeInteger(stock) || stock < 0) {
        return "Stock must be a non-negative integer";
    }

    return null;
}

// Validate numeric product IDs (sends the 400 itself, returns null on failure)
function getProductId(req, res) {
    const value = req.params.id;

    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        sendError(res, 400, "Invalid product ID");
        return null;
    }

    return Number(value);
}

// ========================================
// JWT AUTHORIZATION MIDDLEWARE
// ========================================

// Expected header format: Authorization: Bearer YOUR_TOKEN
function authenticateToken(req, res, next) {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");

    if (!match) {
        return sendError(res, 401, "Authorization token is required");
    }

    try {
        req.user = jwt.verify(match[1], process.env.JWT_SECRET, {
            algorithms: ["HS256"]
        });
        if (!Number.isSafeInteger(req.user.userId) || !Number.isSafeInteger(req.user.tokenVersion)) {
            return sendError(res, 401, "Invalid or expired authorization token");
        }
        const user = db.prepare("SELECT token_version FROM users WHERE id = ?").get(req.user.userId);
        if (!user || user.token_version !== req.user.tokenVersion) {
            return sendError(res, 401, "Invalid or expired authorization token");
        }
        next();
    } catch (error) {
        return sendError(res, 401, "Invalid or expired authorization token");
    }
}

// ========================================
// HOME ROUTE
// GET /
// ========================================

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Node Development Test API is running successfully"
    });
});

// ========================================
// PRODUCT CRUD APIs
// ========================================

// CREATE PRODUCT — POST /products
app.post("/products", authenticateToken, (req, res) => {
    const error = validateProduct(req.body);
    if (error) return sendError(res, 400, error);

    const { name, description = "", price, stock } = req.body;

    const result = db.prepare(
        `INSERT INTO products (name, description, price, stock)
         VALUES (?, ?, ?, ?)`
    ).run(name.trim(), description, price, stock);

    return res.status(201).json({
        success: true,
        message: "Product created successfully",
        product: findProductById(result.lastInsertRowid)
    });
});

// GET ALL PRODUCTS — GET /products
app.get("/products", (req, res) => {
    const products = db.prepare("SELECT * FROM products ORDER BY id").all();

    return res.status(200).json({ success: true, products });
});

// GET PRODUCT BY ID — GET /products/:id
app.get("/products/:id", (req, res) => {
    const id = getProductId(req, res);
    if (id === null) return;

    const product = findProductById(id);
    if (!product) return sendError(res, 404, "Product not found");

    return res.status(200).json({ success: true, product });
});

// UPDATE PRODUCT — PUT /products/:id
app.put("/products/:id", authenticateToken, (req, res) => {
    const id = getProductId(req, res);
    if (id === null) return;

    if (!findProductById(id)) return sendError(res, 404, "Product not found");

    const error = validateProduct(req.body);
    if (error) return sendError(res, 400, error);

    const { name, description = "", price, stock } = req.body;

    db.prepare(
        `UPDATE products
         SET name = ?, description = ?, price = ?, stock = ?
         WHERE id = ?`
    ).run(name.trim(), description, price, stock, id);

    return res.status(200).json({
        success: true,
        message: "Product updated successfully",
        product: findProductById(id)
    });
});

// DELETE PRODUCT — DELETE /products/:id
app.delete("/products/:id", authenticateToken, (req, res) => {
    const id = getProductId(req, res);
    if (id === null) return;

    const result = db.prepare("DELETE FROM products WHERE id = ?").run(id);

    if (result.changes === 0) return sendError(res, 404, "Product not found");

    return res.status(200).json({
        success: true,
        message: "Product deleted successfully"
    });
});

// ========================================
// USER SIGNUP API
// POST /auth/signup
// ========================================

app.post("/auth/signup", async (req, res, next) => {
    try {
        const { name, email, password } = req.body || {};

        if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
            return sendError(res, 400, "Name is required (max 100 characters)");
        }

        if (!isValidEmail(email)) {
            return sendError(res, 400, "Valid email is required");
        }

        if (!isValidPassword(password)) {
            return sendError(res, 400, PASSWORD_MESSAGE);
        }

        const normalizedEmail = normalizeEmail(email);

        const existingUser = db.prepare(
            "SELECT id FROM users WHERE email = ?"
        ).get(normalizedEmail);

        if (existingUser) {
            return sendError(res, 409, "Email is already registered");
        }

        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const result = db.prepare(
            `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`
        ).run(name.trim(), normalizedEmail, hashedPassword);

        return res.status(201).json({
            success: true,
            message: "User registered successfully",
            user: {
                id: Number(result.lastInsertRowid),
                name: name.trim(),
                email: normalizedEmail
            }
        });

    } catch (error) {
        // Duplicate-email constraint (race condition safety net)
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
            return sendError(res, 409, "Email is already registered");
        }
        next(error);
    }
});

// ========================================
// USER LOGIN API
// POST /auth/login
// ========================================

app.post("/auth/login", async (req, res, next) => {
    try {
        const { email, password } = req.body || {};

        if (!isValidEmail(email)) {
            return sendError(res, 400, "Valid email is required");
        }

        if (typeof password !== "string" || !password) {
            return sendError(res, 400, "Password is required");
        }

        const user = db.prepare(
            `SELECT id, name, email, password, token_version FROM users WHERE email = ?`
        ).get(normalizeEmail(email));

        // Always run bcrypt (even for unknown emails) so response time
        // doesn't reveal whether the account exists
        const passwordMatches = await bcrypt.compare(
            password,
            user ? user.password : DUMMY_HASH
        );

        if (!user || !passwordMatches) {
            return sendError(res, 401, "Invalid email or password");
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, tokenVersion: user.token_version },
            process.env.JWT_SECRET,
            {
                expiresIn: process.env.JWT_EXPIRES_IN || "1h",
                algorithm: "HS256"
            }
        );

        return res.status(200).json({
            success: true,
            message: "Login successful",
            token,
            tokenType: "Bearer",
            user: { id: user.id, name: user.name, email: user.email }
        });

    } catch (error) {
        next(error);
    }
});

// ========================================
// FORGOT PASSWORD API
// POST /auth/forgot-password
// ========================================

app.post("/auth/forgot-password", (req, res, next) => {
    try {
        const { email } = req.body || {};

        if (!isValidEmail(email)) {
            return sendError(res, 400, "Valid email is required");
        }

        // Same response whether or not the account exists (prevents enumeration)
        const response = {
            success: true,
            message: "If that email is registered, a password reset request has been recorded"
        };

        const user = db.prepare(
            "SELECT id FROM users WHERE email = ?"
        ).get(normalizeEmail(email));

        if (!user) {
            return res.status(200).json(response);
        }

        // 32 random bytes -> 64 hex chars (matches the reset-password validation)
        const token = crypto.randomBytes(32).toString("hex");
        const now = Date.now();

        db.transaction(() => {
            // Invalidate any earlier outstanding requests for this user
            db.prepare(
                `UPDATE password_resets
                 SET used_at = ?
                 WHERE user_id = ? AND used_at IS NULL`
            ).run(now, user.id);

            // Store only the hash; the raw token is never saved
            db.prepare(
                `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at)
                 VALUES (?, ?, ?, ?)`
            ).run(user.id, sha256(token), now + RESET_TOKEN_TTL_MS, now);
        })();

        // TODO: email the token (e.g. as a link) to the user here.
        // Explicitly opt in for local testing only; never log recovery tokens.
        const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
        if (process.env.NODE_ENV === "development" &&
            process.env.ALLOW_DEV_RESET_TOKEN === "true" && isLoopback) {
            response.resetToken = token;
        }

        return res.status(200).json(response);

    } catch (error) {
        next(error);
    }
});

// ========================================
// RESET PASSWORD API
// POST /auth/reset-password
// ========================================

app.post("/auth/reset-password", async (req, res, next) => {
    try {
        const { token, newPassword } = req.body || {};

        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
            return sendError(res, 400, "Invalid reset token");
        }

        if (!isValidPassword(newPassword)) {
            return sendError(res, 400, PASSWORD_MESSAGE);
        }

        const tokenHash = sha256(token);

        // Find a valid unused token
        const resetRecord = db.prepare(
            `SELECT id, user_id
             FROM password_resets
             WHERE token_hash = ?
               AND used_at IS NULL
               AND expires_at > ?`
        ).get(tokenHash, Date.now());

        if (!resetRecord) {
            return sendError(res, 400, "Reset token is invalid or expired");
        }

        const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

        // Update password and mark token as used atomically
        const savePassword = db.transaction(() => {
            const now = Date.now();

            const claim = db.prepare(
                `UPDATE password_resets
                 SET used_at = ?
                 WHERE id = ? AND used_at IS NULL AND expires_at > ?`
            ).run(now, resetRecord.id, now);

            if (claim.changes !== 1) return false;

            db.prepare(
                "UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?"
            ).run(hashedPassword, resetRecord.user_id);

            // Invalidate other outstanding reset requests
            db.prepare(
                `UPDATE password_resets
                 SET used_at = ?
                 WHERE user_id = ? AND used_at IS NULL`
            ).run(now, resetRecord.user_id);

            return true;
        });

        if (!savePassword()) {
            return sendError(res, 400, "Reset token is invalid or expired");
        }

        return res.status(200).json({
            success: true,
            message: "Password reset successfully"
        });

    } catch (error) {
        next(error);
    }
});

// ========================================
// SHOPIFY PRODUCT APIs
// ========================================

// GET SHOPIFY PRODUCTS
// A read confirms absence; validation/userErrors alone do not imply not-found.
async function shopifyProductExists(id) {
    const data = await shopifyGraphQL(
        "query ProductExists($id: ID!) { product(id: $id) { id } }", { id }
    );
    if (data.product === null) return false;
    if (!data.product || typeof data.product.id !== "string") {
        throw new ShopifyError(502, "Invalid Shopify product response");
    }
    return true;
}

function mutationResult(data, key) {
    const result = data[key];
    if (!result || !Array.isArray(result.userErrors)) {
        throw new ShopifyError(502, "Invalid Shopify mutation response");
    }
    return result;
}

// GET /shopify/products
// JWT authentication required

app.get("/shopify/products", authenticateToken, async (req, res, next) => {
    try {
        // Query products from the Shopify GraphQL Admin API
        const query = `
            query GetShopifyProducts {
                products(first: 20) {
                    nodes {
                        id
                        title
                        handle
                        status
                        description
                    }
                }
            }
        `;

        // Execute Shopify GraphQL request
        const data = await shopifyGraphQL(query);
        if (!Array.isArray(data.products?.nodes)) {
            throw new ShopifyError(502, "Invalid Shopify product response");
        }

        // Return products in Express API response
        return res.status(200).json({
            success: true,
            message: "Shopify products retrieved successfully",
            count: data.products.nodes.length,
            products: data.products.nodes
        });

    } catch (error) {
        // Pass unexpected errors to Express error handler
        next(error);
    }
});
// ========================================
// CREATE SHOPIFY PRODUCT
// POST /shopify/products
// ========================================

app.post("/shopify/products", authenticateToken, async (req, res, next) => {
    try {
        const { title, description = "" } = req.body || {};

        // Validate product title
        if (typeof title !== "string" || !title.trim()) {
            return res.status(400).json({
                success: false,
                message: "Product title is required"
            });
        }

        // Validate product description
        if (typeof description !== "string") {
            return res.status(400).json({
                success: false,
                message: "Description must be a string"
            });
        }

        // Shopify GraphQL mutation to create a product
        const mutation = `
            mutation CreateShopifyProduct($product: ProductCreateInput!) {
                productCreate(product: $product) {
                    product {
                        id
                        title
                        description
                        status
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        // Send product details to Shopify
        const data = await shopifyGraphQL(mutation, {
            product: {
                title: title.trim(),
                descriptionHtml: description.trim(),
                status: "DRAFT"
            }
        });

        // Handle Shopify validation errors
        const result = mutationResult(data, "productCreate");

        if (result.userErrors.length > 0) {
            return res.status(400).json({
                success: false,
                errors: result.userErrors
            });
        }

        if (!result.product) throw new ShopifyError(502, "Invalid Shopify mutation response");

        // Return newly created Shopify product
        return res.status(201).json({
            success: true,
            message: "Shopify product created successfully",
            product: result.product
        });

    } catch (error) {
        next(error);
    }
});
// ========================================
// UPDATE SHOPIFY PRODUCT
// PUT /shopify/products/:id
// ========================================

app.put("/shopify/products/:id", authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { title, description } = req.body || {};

        // Validate numeric Shopify product ID
        if (!/^[1-9]\d*$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Shopify product ID"
            });
        }

        // Require at least one field to update
        if (title === undefined && description === undefined) {
            return res.status(400).json({
                success: false,
                message: "Provide title or description to update"
            });
        }

        const product = {
            id: `gid://shopify/Product/${id}`
        };

        // Validate and include title
        if (title !== undefined) {
            if (typeof title !== "string" || !title.trim()) {
                return res.status(400).json({
                    success: false,
                    message: "Valid product title is required"
                });
            }

            product.title = title.trim();
        }

        // Validate and include description
        if (description !== undefined) {
            if (typeof description !== "string") {
                return res.status(400).json({
                    success: false,
                    message: "Description must be a string"
                });
            }

            product.descriptionHtml = description;
        }

        if (!await shopifyProductExists(product.id)) {
            return sendError(res, 404, "Shopify product not found");
        }

        // Update product using Shopify GraphQL
        const mutation = `
            mutation UpdateShopifyProduct($product: ProductUpdateInput!) {
                productUpdate(product: $product) {
                    product {
                        id
                        title
                        description
                        status
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        const data = await shopifyGraphQL(mutation, { product });
        const result = mutationResult(data, "productUpdate");

        // Handle Shopify validation failures
        if (result.userErrors.length > 0) {
            // Account for deletion between the existence check and mutation.
            if (!await shopifyProductExists(product.id)) {
                return sendError(res, 404, "Shopify product not found");
            }
            return res.status(400).json({
                success: false,
                errors: result.userErrors
            });
        }

        if (!result.product) {
            if (!await shopifyProductExists(product.id)) return sendError(res, 404, "Shopify product not found");
            throw new ShopifyError(502, "Invalid Shopify mutation response");
        }

        return res.status(200).json({
            success: true,
            message: "Shopify product updated successfully",
            product: result.product
        });

    } catch (error) {
        next(error);
    }
});
// ========================================
// DELETE SHOPIFY PRODUCT
// DELETE /shopify/products/:id
// ========================================

app.delete("/shopify/products/:id", authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;

        // Validate Shopify product ID
        if (!/^[1-9]\d*$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Shopify product ID"
            });
        }

        const gid = `gid://shopify/Product/${id}`;
        if (!await shopifyProductExists(gid)) {
            return sendError(res, 404, "Shopify product not found");
        }

        // Shopify GraphQL product deletion mutation
        const mutation = `
            mutation DeleteShopifyProduct($input: ProductDeleteInput!) {
                productDelete(input: $input) {
                    deletedProductId
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        // Request product deletion from Shopify
        const data = await shopifyGraphQL(mutation, {
            input: {
                id: `gid://shopify/Product/${id}`
            }
        });

        const result = mutationResult(data, "productDelete");

        // Handle errors returned by Shopify
        if (result.userErrors.length > 0) {
            if (!await shopifyProductExists(gid)) return sendError(res, 404, "Shopify product not found");
            return res.status(400).json({
                success: false,
                errors: result.userErrors
            });
        }

        if (!result.deletedProductId) {
            if (!await shopifyProductExists(gid)) return sendError(res, 404, "Shopify product not found");
            throw new ShopifyError(502, "Invalid Shopify mutation response");
        }

        return res.status(200).json({
            success: true,
            message: "Shopify product deleted successfully",
            deletedProductId: result.deletedProductId
        });

    } catch (error) {
        next(error);
    }
});
// ========================================
// UNKNOWN ROUTE HANDLER 
// ========================================

app.use((req, res) => {
    sendError(res, 404, "Route not found");
});

// ========================================
// GLOBAL ERROR HANDLER 
// ========================================

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ShopifyError) {
        if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
        return sendError(res, err.status, err.message);
    }
    // Do not serialize unexpected error objects, which may contain request data.
    console.error("Request failed with an internal error");
    sendError(res, 500, "Internal server error");
});

// ========================================
// START EXPRESS SERVER
// ========================================

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
