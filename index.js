const express = require("express");
const crypto = require("node:crypto");

const app = express();

// Capture raw bodies without assuming they're JSON or text.
app.use(express.raw({
    type: () => true,
    limit: "10mb"
}));

app.all("/{*path}", (req, res) => {
    const payload = {
        version: 1,
        type: "http_request",
        id: crypto.randomUUID(),

        request: {
            method: req.method,
            url: req.originalUrl,
            httpVersion: req.httpVersion,
            headers: req.headers,
            body: {
                encoding: "base64",
                data: req.body?.toString("base64") ?? ""
            }
        }
    };

    console.log(payload);

    res.json({ received: true, id: payload.id });
});

app.listen(8000);
