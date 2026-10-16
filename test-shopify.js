// ========================================
// TEST SHOPIFY CONNECTION
// ========================================

const { getShopifyToken, shopifyGraphQL } = require("./shopify");

async function testConnection() {
    try {
        console.log("Connecting to Shopify...");

        // Step 1: Verify authentication
        await getShopifyToken();

        console.log("Shopify authentication successful!");

        // Step 2: Retrieve first five products
        const query = `
            query {
                products(first: 5) {
                    nodes {
                        id
                        title
                        handle
                        status
                    }
                }
            }
        `;

        const data = await shopifyGraphQL(query);

        console.log("Shopify GraphQL connection successful!");
        console.log(
            "Products:",
            JSON.stringify(data.products.nodes, null, 2)
        );

    } catch (error) {
        console.error("Connection test failed:", error.message);
        process.exitCode = 1;
    }
}

testConnection();