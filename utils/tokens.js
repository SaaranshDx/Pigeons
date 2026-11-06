const crypto = require("node:crypto");

const TOKEN_PREFIX = "ptk_";
const TOKEN_BODY_LENGTH = 16;
const TOKEN_PATTERN = new RegExp(
    `^${TOKEN_PREFIX}[A-Za-z0-9]{${TOKEN_BODY_LENGTH}}$`
);

function createToken() {
    return `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BODY_LENGTH / 2).toString("hex")}`;
}

function isValidToken(token) {
    return typeof token === "string" && TOKEN_PATTERN.test(token);
}

module.exports = {
    TOKEN_PATTERN,
    createToken,
    isValidToken
};
