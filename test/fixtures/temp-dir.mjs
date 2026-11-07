import { after } from "node:test";
import { mkdtemp as createTempDir, rm } from "node:fs/promises";

const directories = new Set();

// Register at module load so cleanup follows every test in this worker, including failures.
after(async () => {
  await Promise.all([...directories].map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 })
  ));
});

export async function mkdtemp(prefix) {
  const directory = await createTempDir(prefix);
  directories.add(directory);
  return directory;
}
