export const GAME_CHANNELS = Object.freeze([
 {packageId:"com.bilibili.sirius.official",label:"国际版（官网）"},
 {packageId:"com.bilibili.sirius",label:"国际版（Google Play）"},
 {packageId:"com.bushiroad.sirius",label:"日服"},
]);
export function selectGameChannel(installedText, requested = "") {
 const installed = new Set(String(installedText || "").split(/\r?\n/).map(s=>s.replace(/^package:/,"" ).trim()));
 const channels=GAME_CHANNELS.filter(c=>installed.has(c.packageId));
 if(requested) {
  const chosen=channels.find(c=>c.packageId===requested);
  if(!chosen) throw new Error("所选游戏版本未安装，请检查版本选择。不要重命名游戏目录。");
  return chosen;
 }
 if(!channels.length) throw new Error("没有找到受支持的 Our Notes 游戏。支持国际版官网、Google Play 国际版和日服。不要给文件或目录添加 .official。");
 if(channels.length>1) throw new Error("检测到多个游戏版本，请先选择要读取的版本后重试。");
 return channels[0];
}
