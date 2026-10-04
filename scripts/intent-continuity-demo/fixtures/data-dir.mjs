export function getDataDir() {
  if (!process.env.INTENT_DEMO_DATA_DIR) throw new Error('Private demo data directory is absent');
  return process.env.INTENT_DEMO_DATA_DIR;
}
