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
    const online = data.status === "ok";
    healthLabel.dataset.health = online ? "online" : "offline";
    healthLabel.textContent = online ? "云端在线" : "服务异常";
    databaseStatus.textContent = online ? "在线" : "未连接";
    databaseDetail.textContent = online ? "服务运行正常" : "数据库迁移尚未就绪";
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
