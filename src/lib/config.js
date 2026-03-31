const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const BUNDLED_DIR = path.resolve(__dirname, '..', 'config');
const SCHEMA_PATH = path.join(BUNDLED_DIR, 'schema.json');
const BUNDLED_CONFIG_PATH = path.join(BUNDLED_DIR, 'config.json');

const CONFIG_DIR = process.env.CONFIG_DIR || BUNDLED_DIR;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    ensureDir(CONFIG_DIR);
    const defaultConfig = fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, defaultConfig, 'utf8');
    console.log('Created default config at', CONFIG_PATH);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const valid = validate(cfg);
  if (!valid) {
    const err = new Error('Invalid config: ' + ajv.errorsText(validate.errors));
    err.details = validate.errors;
    throw err;
  }
  return cfg;
}

function saveConfig(cfg) {
  const valid = validate(cfg);
  if (!valid) {
    const err = new Error('Invalid config: ' + ajv.errorsText(validate.errors));
    err.details = validate.errors;
    throw err;
  }
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return true;
}

module.exports = { loadConfig, saveConfig };
