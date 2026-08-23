const healthLabel = document.querySelector("[data-health]");
const clock = document.querySelector("#clock");
const today = document.querySelector("#today");
const databaseStatus = document.querySelector("#database-status");
const databaseDetail = document.querySelector("#database-detail");

function updateClock() {
  const now = new Date();
  clock.textContent = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  today.textContent = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(now);
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    healthLabel.dataset.health = data.ok ? "online" : "offline";
    healthLabel.textContent = data.ok ? `云端在线 · ${data.colo ?? "--"}` : "服务异常";
    databaseStatus.textContent = data.database?.ok ? "在线" : "未连接";
    databaseDetail.textContent = data.database?.ok
      ? `Schema ${data.database.schemaVersion ?? "unknown"}`
      : "数据库迁移尚未就绪";
  } catch {
    healthLabel.dataset.health = "offline";
    healthLabel.textContent = "连接失败";
    databaseStatus.textContent = "未知";
    databaseDetail.textContent = "无法读取数据库状态";
  }
}

updateClock();
setInterval(updateClock, 1000);
checkHealth();
