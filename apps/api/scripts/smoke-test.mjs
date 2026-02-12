import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const apiDir = resolve(__dirname, "..");
const port = Number(process.env.API_SMOKE_PORT ?? 8791);
const baseUrl = `http://127.0.0.1:${port}`;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const runMigrations = () => {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "paste-db", "--local"],
    {
      cwd: apiDir,
      encoding: "utf-8"
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `failed to apply local migrations\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
};

const startDevServer = () => {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--local"], {
    cwd: apiDir,
    env: {
      ...process.env,
      CI: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  const appendLogs = (chunk) => {
    logs += chunk.toString();
    if (logs.length > 12000) {
      logs = logs.slice(-12000);
    }
  };

  child.stdout.on("data", appendLogs);
  child.stderr.on("data", appendLogs);

  return { child, getLogs: () => logs };
};

const waitForHealth = async (timeoutMs, getLogs, child) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}\n${getLogs()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore and retry.
    }

    await sleep(400);
  }

  throw new Error(`wrangler dev did not become ready in time\n${getLogs()}`);
};

const stopDevServer = async (child) => {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const timeout = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 2500);

  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
};

const requestApi = async ({
  path,
  method = "GET",
  userId,
  deviceId,
  body,
  expectedStatus = 200
}) => {
  const headers = {};
  if (userId) {
    headers["x-user-id"] = userId;
  }
  if (deviceId) {
    headers["x-device-id"] = deviceId;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  assert(
    response.status === expectedStatus,
    `${method} ${path} expected status ${expectedStatus}, got ${response.status}, body: ${text}`
  );

  return data;
};

const run = async () => {
  runMigrations();

  const { child, getLogs } = startDevServer();
  try {
    await waitForHealth(40000, getLogs, child);

    const now = Date.now();
    const userId = `u_smoke_${now}`;
    const deviceA = "dev_mac_smoke";
    const deviceB = "dev_ios_smoke";

    const health = await requestApi({ path: "/v1/health", expectedStatus: 200 });
    assert(health?.ok === true, "health check response is invalid");

    const createOne = await requestApi({
      path: "/v1/clips",
      method: "POST",
      userId,
      deviceId: deviceA,
      expectedStatus: 201,
      body: {
        type: "text",
        summary: "alpha",
        content: `alpha-content-${userId}`,
        tags: ["work", "alpha"],
        isFavorite: false,
        clientUpdatedAt: now - 2000
      }
    });
    assert(createOne?.ok === true, "create clip one failed");
    const clipOne = createOne.data;

    const createTwo = await requestApi({
      path: "/v1/clips",
      method: "POST",
      userId,
      deviceId: deviceA,
      expectedStatus: 201,
      body: {
        type: "text",
        summary: "beta",
        content: `beta-content-${userId}`,
        tags: ["personal"],
        isFavorite: false,
        clientUpdatedAt: now - 1000
      }
    });
    assert(createTwo?.ok === true, "create clip two failed");
    const clipTwo = createTwo.data;

    const linkUrl = `https://example.com/smoke/${userId}`;
    const createLink = await requestApi({
      path: "/v1/clips",
      method: "POST",
      userId,
      deviceId: deviceA,
      expectedStatus: 201,
      body: {
        type: "link",
        content: linkUrl,
        sourceUrl: linkUrl,
        tags: ["work"],
        clientUpdatedAt: now - 800
      }
    });
    assert(createLink?.ok === true, "create link clip failed");
    const linkClip = createLink.data;
    assert(linkClip.type === "link", "link clip type mismatch");
    assert(linkClip.sourceUrl === linkUrl, "link clip sourceUrl mismatch");

    const htmlPayload = `<div><b>smoke-html-rich</b><i> rich html text </i></div>`;
    const createHtml = await requestApi({
      path: "/v1/clips",
      method: "POST",
      userId,
      deviceId: deviceA,
      expectedStatus: 201,
      body: {
        type: "html",
        content: "smoke html",
        contentHtml: htmlPayload,
        clientUpdatedAt: now - 700
      }
    });
    assert(createHtml?.ok === true, "create html clip failed");
    const htmlClip = createHtml.data;
    assert(htmlClip.type === "html", "html clip type mismatch");
    assert(htmlClip.contentHtml && htmlClip.contentHtml.includes("smoke-html-rich"), "html content missing");

    const tinyImageDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+0XkAAAAASUVORK5CYII=";
    const createImage = await requestApi({
      path: "/v1/clips",
      method: "POST",
      userId,
      deviceId: deviceA,
      expectedStatus: 201,
      body: {
        type: "image",
        content: "tiny-image",
        imageDataUrl: tinyImageDataUrl,
        clientUpdatedAt: now - 600
      }
    });
    assert(createImage?.ok === true, "create image clip failed");
    const imageClip = createImage.data;
    assert(imageClip.type === "image", "image clip type mismatch");
    assert(imageClip.imageDataUrl === tinyImageDataUrl, "image clip data mismatch");

    const search = await requestApi({
      path: "/v1/clips?q=alpha-content",
      userId,
      deviceId: deviceA
    });
    assert(search?.ok === true, "search query failed");
    assert(
      search.data.items.some((item) => item.id === clipOne.id),
      "search result does not contain clip one"
    );

    const searchLink = await requestApi({
      path: `/v1/clips?q=${encodeURIComponent(`example.com/smoke/${userId}`)}`,
      userId,
      deviceId: deviceA
    });
    assert(searchLink?.ok === true, "search by source url failed");
    assert(
      searchLink.data.items.some((item) => item.id === linkClip.id),
      "search by source url does not contain link clip"
    );

    const searchHtml = await requestApi({
      path: "/v1/clips?q=smoke-html-rich",
      userId,
      deviceId: deviceA
    });
    assert(searchHtml?.ok === true, "search by html failed");
    assert(
      searchHtml.data.items.some((item) => item.id === htmlClip.id),
      "search by html does not contain html clip"
    );

    const patchTwo = await requestApi({
      path: `/v1/clips/${encodeURIComponent(clipTwo.id)}`,
      method: "PATCH",
      userId,
      deviceId: deviceA,
      body: {
        isFavorite: true,
        tags: ["work", "star"],
        clientUpdatedAt: clipTwo.clientUpdatedAt + 1000
      }
    });
    assert(patchTwo?.ok === true, "patch clip two failed");

    const favorites = await requestApi({
      path: "/v1/clips?favorite=1",
      userId,
      deviceId: deviceA
    });
    assert(favorites?.ok === true, "favorite filter failed");
    assert(
      favorites.data.items.some((item) => item.id === clipTwo.id),
      "favorite list does not contain clip two"
    );

    const byTag = await requestApi({
      path: "/v1/clips?tag=work",
      userId,
      deviceId: deviceA
    });
    assert(byTag?.ok === true, "tag filter failed");
    assert(
      byTag.data.items.some((item) => item.id === clipOne.id) &&
        byTag.data.items.some((item) => item.id === clipTwo.id),
      "tag filter does not contain both clips"
    );

    const syncPull = await requestApi({
      path: "/v1/sync/pull?since=0&limit=50",
      userId,
      deviceId: deviceB
    });
    assert(syncPull?.ok === true, "sync pull failed");
    const pulledClipTwo = syncPull.data.changes.find((item) => item.id === clipTwo.id);
    assert(pulledClipTwo, "sync pull did not contain clip two");

    const pulledImage = syncPull.data.changes.find((item) => item.id === imageClip.id);
    assert(pulledImage?.imageDataUrl, "sync pull did not contain image data");

    const conflictPush = await requestApi({
      path: "/v1/sync/push",
      method: "POST",
      userId,
      deviceId: deviceB,
      body: {
        changes: [
          {
            id: clipTwo.id,
            summary: "outdated-change",
            clientUpdatedAt: pulledClipTwo.clientUpdatedAt - 1
          }
        ]
      }
    });
    assert(conflictPush?.ok === true, "sync push conflict request failed");
    assert(
      conflictPush.data.conflicts.some((item) => item.id === clipTwo.id),
      "expected conflict was not returned"
    );

    const applyPush = await requestApi({
      path: "/v1/sync/push",
      method: "POST",
      userId,
      deviceId: deviceB,
      body: {
        changes: [
          {
            id: clipTwo.id,
            summary: "newer-change-from-device-b",
            clientUpdatedAt: pulledClipTwo.clientUpdatedAt + 2000
          }
        ]
      }
    });
    assert(applyPush?.ok === true, "sync push apply request failed");
    assert(
      applyPush.data.applied.some((item) => item.id === clipTwo.id),
      "newer sync push was not applied"
    );

    const removeOne = await requestApi({
      path: `/v1/clips/${encodeURIComponent(clipOne.id)}`,
      method: "DELETE",
      userId,
      deviceId: deviceA,
      body: {
        clientUpdatedAt: now + 5000
      }
    });
    assert(removeOne?.ok === true, "soft delete failed");

    const afterDelete = await requestApi({
      path: "/v1/clips",
      userId,
      deviceId: deviceA
    });
    assert(afterDelete?.ok === true, "list after delete failed");
    assert(
      !afterDelete.data.items.some((item) => item.id === clipOne.id),
      "deleted clip still appears in default list"
    );

    const includeDeleted = await requestApi({
      path: "/v1/clips?includeDeleted=1",
      userId,
      deviceId: deviceA
    });
    assert(includeDeleted?.ok === true, "includeDeleted list failed");
    assert(
      includeDeleted.data.items.some((item) => item.id === clipOne.id && item.isDeleted),
      "deleted clip is missing in includeDeleted list"
    );

    console.log("API smoke test passed.");
  } finally {
    await stopDevServer(child);
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
