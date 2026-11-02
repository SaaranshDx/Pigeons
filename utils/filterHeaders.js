const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
]);

function filterHeaders(headers) {
    const blocked = new Set(HOP_BY_HOP);

    // Connection can nominate additional hop-by-hop headers.
    const connection = headers.connection || "";

    for (const name of connection.split(",")) {
        const normalized = name.trim().toLowerCase();
        if (normalized) blocked.add(normalized);
    }

    return Object.fromEntries(
        Object.entries(headers).filter(
            ([name]) => !blocked.has(name.toLowerCase())
        )
    );
}

module.exports = { filterHeaders };
