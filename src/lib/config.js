const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SCHEMA_PATH = path.join(CONFIG_DIR, 'schema.json');

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

function loadConfig() {
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return true;
}

module.exports = { loadConfig, saveConfig };
