const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function fail(message) {
    console.error(`[SEA] ${message}`);
    process.exit(1);
}

const configArgument = process.argv[2];

if (!configArgument) {
    fail("Usage: node agent/build-sea.js <path-to-sea-config.json>");
}

const configPath = path.resolve(configArgument);

if (!fs.existsSync(configPath)) {
    fail(`SEA config not found: ${configPath}`);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (typeof config.main !== "string" || typeof config.output !== "string") {
    fail("SEA config must define string values for main and output");
}

const configDirectory = path.dirname(configPath);
const mainPath = path.resolve(configDirectory, config.main);
const outputPath = path.resolve(configDirectory, config.output);
const blobPath = `${outputPath}.blob`;
const temporaryConfigPath = path.join(
    os.tmpdir(),
    `pigeons-sea-${process.pid}-${Date.now()}.json`
);
const postjectPath = require.resolve("postject/dist/cli.js");

if (!fs.existsSync(mainPath)) {
    fail(`SEA main script not found: ${mainPath}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const preparationConfig = {
    ...config,
    main: mainPath,
    output: blobPath
};

fs.writeFileSync(temporaryConfigPath, JSON.stringify(preparationConfig));

function run(command, argumentsList) {
    const result = spawnSync(command, argumentsList, { stdio: "inherit" });

    if (result.error) {
        fail(`Could not start ${command}: ${result.error.message}`);
    }

    if (result.status !== 0) {
        fail(`${command} exited with status ${result.status}`);
    }
}

try {
    console.log(`[SEA] Preparing ${path.basename(configPath)}`);
    run(process.execPath, ["--experimental-sea-config", temporaryConfigPath]);

    fs.copyFileSync(process.execPath, outputPath);

    console.log(`[SEA] Embedding blob into ${outputPath}`);
    run(process.execPath, [
        postjectPath,
        outputPath,
        "NODE_SEA_BLOB",
        blobPath,
        "--sentinel-fuse",
        SENTINEL_FUSE
    ]);

    if (process.platform !== "win32") {
        fs.chmodSync(outputPath, 0o755);
    }

    console.log(`[SEA] Wrote ${outputPath}`);
} finally {
    fs.rmSync(temporaryConfigPath, { force: true });
    fs.rmSync(blobPath, { force: true });
}
