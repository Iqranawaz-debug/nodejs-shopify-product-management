// Shopify Admin GraphQL transport. Never include upstream bodies or secrets in errors.
require("dotenv").config();
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = "2026-10";
if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) throw new Error("Missing Shopify credentials in .env");

class ShopifyError extends Error {
    constructor(status, message, retryAfter) {
        super(message);
        this.name = "ShopifyError";
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

// Timeout covers both headers and response body. Do not retry mutations:
// a lost response does not mean the write failed at Shopify.
async function requestJSON(url, options) {
    try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
            if (response.status === 429 || response.status === 503) {
                const retry = Number(response.headers?.get("retry-after"));
                throw new ShopifyError(503, "Shopify is temporarily unavailable; try again later",
                    Number.isFinite(retry) && retry > 0 ? Math.min(3600, Math.ceil(retry)) : 1);
            }
            throw new ShopifyError(502, "Shopify upstream request failed");
        }
        const data = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new ShopifyError(502, "Invalid Shopify response");
        }
        return data;
    } catch (error) {
        if (error instanceof ShopifyError) throw error;
        if (error.name === "TimeoutError" || error.name === "AbortError") {
            throw new ShopifyError(504, "Shopify request timed out");
        }
        throw new ShopifyError(502, "Shopify upstream request failed");
    }
}

let cachedToken = null;
let tokenExpiresAt = 0;
async function getShopifyToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    const data = await requestJSON(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    });
    if (typeof data.access_token !== "string" || !data.access_token) {
        throw new ShopifyError(502, "Invalid Shopify authentication response");
    }
    cachedToken = data.access_token;
    const expires = Number(data.expires_in);
    tokenExpiresAt = Date.now() + Math.max(0, (Number.isFinite(expires) && expires > 0 ? expires : 86400) - 60) * 1000;
    return cachedToken;
}

async function shopifyGraphQL(query, variables = {}) {
    const token = await getShopifyToken();
    const result = await requestJSON(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables })
    });
    if (result.errors?.length) {
        if (result.errors.some(error => error.extensions?.code === "THROTTLED")) {
            throw new ShopifyError(503, "Shopify rate limit reached; try again later", 1);
        }
        throw new ShopifyError(502, "Shopify GraphQL request failed");
    }
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        throw new ShopifyError(502, "Invalid Shopify response");
    }
    return result.data;
}
module.exports = { getShopifyToken, shopifyGraphQL, ShopifyError };
