const path = require("path");

/**
 * Windows 便携包构建（Electron 部分）
 * 输出：node-app/dist-win/opencode-mesh-win32-x64/
 * 完整 kit 组装（含仓库运行时快照与 zip）见 scripts/pack-kit.js
 */
(async () => {
  const mod = await import("@electron/packager");
  const packager = mod.packager ?? mod.default;
  const appPaths = await packager({
    dir: __dirname,
    name: "opencode-mesh",
    platform: "win32",
    arch: "x64",
    out: path.join(__dirname, "dist-win"),
    overwrite: true,
    icon: path.join(__dirname, "assets", "icon.ico"),
    ignore: [
      /^\/dist-win($|\/)/,
      /^\/dist-linux($|\/)/,
      /^\/make-icon\.js$/,
      /^\/pack-linux\.js$/,
      /^\/pack-win\.js$/,
      /^\/start-bot\.cmd$/,
      /^\/start-bot\.vbs$/,
      /^\/autostart\.ps1$/,
    ],
    prune: true,
  });
  console.log("packaged:", appPaths.join(", "));
})().catch((e) => {
  console.error("pack failed:", e);
  process.exit(1);
});
