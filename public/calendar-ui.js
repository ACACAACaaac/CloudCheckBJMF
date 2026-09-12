(() => {
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
  const WEEKDAY_OPTIONS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function dateFromKey(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  }

  function normalizeCourseIds(courses) {
    const used = new Set();
    courses.forEach((course, index) => {
      if (!course || typeof course !== "object" || Array.isArray(course)) {
        courses[index] = { name: String(course ?? "").trim() || `课程 ${index + 1}`, location_group: "" };
      }
      const target = courses[index];
      const existing = String(target.id ?? "").trim();
      let id = existing && !used.has(existing) ? existing : `legacy-course-${index + 1}`;
      let suffix = 2;
      while (used.has(id)) {
        id = `legacy-course-${index + 1}-${suffix}`;
        suffix += 1;
      }
      target.id = id;
      used.add(id);
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function projectCoordinate(lat, lng, zoom) {
    const size = 256 * (2 ** zoom);
    const safeLat = clamp(Number(lat), -85.05112878, 85.05112878);
    const radians = safeLat * Math.PI / 180;
    return {
      x: ((Number(lng) + 180) / 360) * size,
      y: (1 - Math.log(Math.tan(radians) + (1 / Math.cos(radians))) / Math.PI) / 2 * size,
      size,
    };
  }

  function unprojectCoordinate(x, y, zoom) {
    const size = 256 * (2 ** zoom);
    const lng = (x / size) * 360 - 180;
    const mercator = Math.PI * (1 - 2 * y / size);
    const lat = Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
    return { lat: clamp(lat, -85.05112878, 85.05112878), lng: ((lng + 540) % 360) - 180 };
  }

  function normalizedDocument(value) {
    const document = value && typeof value === "object" ? clone(value) : {};
    document.version = 1;
    document.locations = Array.isArray(document.locations) ? document.locations : [];
    document.users = Array.isArray(document.users) ? document.users : [];
    return document;
  }

  class CalendarEditor {
    constructor(root, onChange) {
      this.root = root;
      this.onChange = onChange;
      this.document = normalizedDocument({});
      this.username = "";
      this.classes = [];
      this.selectedDate = dateKey(new Date());
      this.cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
      this.dialogMode = null;
      this.dialogPayload = null;
      this.mapState = {
        lat: 30.335114,
        lng: 120.037703,
        centerLat: 30.335114,
        centerLng: 120.037703,
        zoom: 16,
        targetIndex: null,
      };
      this.mount();
      this.bind();
    }

    mount() {
      this.root.innerHTML = `
        <div class="calendar-toolbar">
          <div class="calendar-tools">
            <div class="cal-tool-help"><button class="cal-tool" data-cal-tool="courses">课程任务</button><button class="info-tip" type="button" aria-label="了解课程任务">i<span><strong>适合固定地点的课程。</strong>先创建课程名称并绑定一个坐标组，例如“高等数学 → E13”。以后新建单次或重复任务时选择这门课程，名称和地点会自动带入且不能随意改动，可避免同一门课被填到错误地点。课程本身不包含上课时间。</span></button></div>
            <div class="cal-tool-help"><button class="cal-tool" data-cal-tool="singles">单次任务</button><button class="info-tip" type="button" aria-label="了解单次任务">i<span><strong>只在某一天执行一次。</strong>适合临时讲座、补课或某次特殊签到。选择日期、开始时间和地点后保存；到该时间前后的日历任务窗口内，系统会优先使用这个任务指定的坐标检查签到。</span></button></div>
            <div class="cal-tool-help"><button class="cal-tool" data-cal-tool="repeats">重复任务</button><button class="info-tip" type="button" aria-label="了解重复任务">i<span><strong>按规律自动出现在日历里。</strong>适合每周课表或每天固定安排。先选择每天重复或每周重复，再填写每次发生的星期和时间，以及开始、截止日期。修改重复任务会同时影响整组安排；若只想改某一天，请在日历当天编辑单项。</span></button></div>
          </div>
        </div>
        <div class="calendar-nav">
          <button data-cal-nav="-1" aria-label="上个月">←</button>
          <button data-cal-nav="today">今天</button>
          <strong id="calendar-month-title"></strong>
          <button data-cal-nav="1" aria-label="下个月">→</button>
        </div>
        <div class="calendar-layout">
          <div class="month-board">
            <div class="weekday-row">${WEEKDAYS.map((day) => `<span>周${day}</span>`).join("")}</div>
            <div class="month-grid" id="month-grid"></div>
          </div>
          <aside class="day-drawer">
            <div class="day-drawer-head">
              <div><small>当天安排</small><strong id="selected-date-title"></strong></div>
              <button data-cal-action="new-day-task">＋ 新任务</button>
            </div>
            <div id="selected-task-list" class="selected-task-list"></div>
          </aside>
        </div>
        <dialog class="calendar-dialog" id="calendar-dialog">
          <div class="calendar-dialog-head">
            <div><small id="calendar-dialog-kicker">日历工具</small><h3 id="calendar-dialog-title"></h3></div>
            <button data-cal-action="close-dialog" aria-label="关闭">×</button>
          </div>
          <div id="calendar-dialog-body"></div>
        </dialog>
      `;
      this.dialog = this.root.querySelector("#calendar-dialog");
      document.body.append(this.dialog);
    }

    bind() {
      const handleClick = (event) => {
        const nav = event.target.closest("[data-cal-nav]");
        if (nav) return this.navigate(nav.dataset.calNav);
        const day = event.target.closest("[data-cal-date]");
        if (day) {
          this.selectedDate = day.dataset.calDate;
          this.render();
          return;
        }
        const tool = event.target.closest("[data-cal-tool]");
        if (tool) return this.openDialog(tool.dataset.calTool);
        const action = event.target.closest("[data-cal-action]");
        if (action) this.handleAction(action.dataset.calAction, action.dataset);
      };
      for (const target of [this.root, this.dialog]) {
        target.addEventListener("click", handleClick);
        target.addEventListener("change", (event) => this.handleChange(event.target));
        target.addEventListener("input", (event) => {
          if (event.target.matches("[data-cal-field]")) this.updateField(event.target, false);
        });
      }
    }

    setDocument(value, username, classes = []) {
      this.document = normalizedDocument(value);
      this.username = username || "当前用户";
      this.classes = [...new Set((classes ?? []).map(String))];
      const user = this.currentUser(true);
      user.classes = this.classes;
      this.render();
    }

    getDocument() {
      const user = this.currentUser(true);
      user.classes = this.classes;
      return clone(this.document);
    }

    openLocations() {
      const first = this.locations()[0];
      if (first?.location) {
        this.selectLocationOnMap(0);
        this.mapState.targetIndex = null;
      }
      this.openDialog("locations");
    }

    selectLocationOnMap(index) {
      const group = this.locations()[index];
      if (!group) return;
      const lat = Number(group.location?.lat);
      const lng = Number(group.location?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        this.mapState.lat = lat;
        this.mapState.lng = lng;
        this.mapState.centerLat = lat;
        this.mapState.centerLng = lng;
      }
      this.mapState.targetIndex = index;
    }

    mapDraft() {
      const name = this.dialog.querySelector("#map-location-name")?.value.trim() ||
        `地图坐标 ${this.locations().length + 1}`;
      const lat = Number(this.dialog.querySelector("#map-location-lat")?.value);
      const lng = Number(this.dialog.querySelector("#map-location-lng")?.value);
      const acc = Number(this.dialog.querySelector("#map-location-acc")?.value);
      if (!Number.isFinite(lat) || lat < -85.05112878 || lat > 85.05112878) {
        throw new Error("地图纬度无效");
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error("地图经度无效");
      return { name, location: { lat: Number(lat.toFixed(8)), lng: Number(lng.toFixed(8)), acc: Math.max(1, acc || 20) } };
    }

    mountLocationMap() {
      const map = this.dialog.querySelector("#location-map");
      if (!map) return;
      const tileLayer = map.querySelector(".map-tiles");
      const marker = map.querySelector(".map-marker");
      const tileImages = new Map();

      const render = () => {
        const width = map.clientWidth;
        const height = map.clientHeight;
        if (!width || !height) return;
        const zoom = this.mapState.zoom;
        const center = projectCoordinate(this.mapState.centerLat, this.mapState.centerLng, zoom);
        const left = center.x - width / 2;
        const top = center.y - height / 2;
        const count = 2 ** zoom;
        const desired = new Set();
        for (let tileY = Math.floor(top / 256); tileY <= Math.floor((top + height) / 256); tileY += 1) {
          if (tileY < 0 || tileY >= count) continue;
          for (let tileX = Math.floor(left / 256); tileX <= Math.floor((left + width) / 256); tileX += 1) {
            const wrappedX = ((tileX % count) + count) % count;
            const key = `${zoom}/${wrappedX}/${tileY}/${tileX}`;
            desired.add(key);
            let image = tileImages.get(key);
            if (!image) {
              image = document.createElement("img");
              image.src = `/api/map/tiles/${zoom}/${wrappedX}/${tileY}.png`;
              image.alt = "";
              image.draggable = false;
              image.decoding = "async";
              tileImages.set(key, image);
              tileLayer.append(image);
            }
            image.style.left = `${tileX * 256 - left}px`;
            image.style.top = `${tileY * 256 - top}px`;
          }
        }
        for (const [key, image] of tileImages) {
          if (!desired.has(key)) {
            image.remove();
            tileImages.delete(key);
          }
        }
        const point = projectCoordinate(this.mapState.lat, this.mapState.lng, zoom);
        marker.style.left = `${point.x - left}px`;
        marker.style.top = `${point.y - top}px`;
        const latInput = this.dialog.querySelector("#map-location-lat");
        const lngInput = this.dialog.querySelector("#map-location-lng");
        if (latInput) latInput.value = Number(this.mapState.lat).toFixed(8);
        if (lngInput) lngInput.value = Number(this.mapState.lng).toFixed(8);
        const zoomLabel = map.querySelector(".map-zoom-label");
        if (zoomLabel) zoomLabel.textContent = `Z${zoom}`;
        map._coordinateFrame = { left, top };
      };

      const pointers = new Map();
      let gesture = null;
      const pointerDistance = () => {
        const [first, second] = [...pointers.values()];
        return Math.hypot(second.x - first.x, second.y - first.y);
      };
      const beginPan = (pointer, suppressTap = false) => {
        gesture = {
          mode: "pan",
          pointerId: pointer.id,
          x: pointer.x,
          y: pointer.y,
          center: projectCoordinate(this.mapState.centerLat, this.mapState.centerLng, this.mapState.zoom),
          moved: suppressTap,
        };
      };
      const beginPinch = () => {
        gesture = {
          mode: "pinch",
          startDistance: Math.max(1, pointerDistance()),
          startZoom: this.mapState.zoom,
        };
      };
      map.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button, a")) return;
        map.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
        if (pointers.size === 1) beginPan([...pointers.values()][0]);
        else if (pointers.size === 2) beginPinch();
      });
      map.addEventListener("pointermove", (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
        if (pointers.size >= 2) {
          if (gesture?.mode !== "pinch") beginPinch();
          const zoomDelta = Math.log2(pointerDistance() / gesture.startDistance);
          const nextZoom = clamp(Math.round(gesture.startZoom + zoomDelta), 3, 19);
          if (nextZoom !== this.mapState.zoom) {
            this.mapState.zoom = nextZoom;
            render();
          }
          return;
        }
        if (gesture?.mode !== "pan" || gesture.pointerId !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        gesture.moved ||= Math.abs(dx) + Math.abs(dy) > 5;
        const center = unprojectCoordinate(gesture.center.x - dx, gesture.center.y - dy, this.mapState.zoom);
        this.mapState.centerLat = center.lat;
        this.mapState.centerLng = center.lng;
        render();
      });
      const finishPointer = (event, cancelled = false) => {
        if (!pointers.has(event.pointerId)) return;
        const wasTap = !cancelled && pointers.size === 1 && gesture?.mode === "pan" &&
          gesture.pointerId === event.pointerId && !gesture.moved;
        pointers.delete(event.pointerId);
        if (wasTap) {
          const rect = map.getBoundingClientRect();
          const frame = map._coordinateFrame;
          const selected = unprojectCoordinate(
            frame.left + event.clientX - rect.left,
            frame.top + event.clientY - rect.top,
            this.mapState.zoom,
          );
          this.mapState.lat = selected.lat;
          this.mapState.lng = selected.lng;
        }
        if (pointers.size === 1) beginPan([...pointers.values()][0], true);
        else if (pointers.size >= 2) beginPinch();
        else gesture = null;
        render();
      };
      map.addEventListener("pointerup", (event) => finishPointer(event));
      map.addEventListener("pointercancel", (event) => finishPointer(event, true));
      map.addEventListener("wheel", (event) => {
        event.preventDefault();
        this.mapState.zoom = clamp(this.mapState.zoom + (event.deltaY < 0 ? 1 : -1), 3, 19);
        render();
      }, { passive: false });
      map.querySelectorAll("[data-map-zoom]").forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.mapState.zoom = clamp(this.mapState.zoom + Number(button.dataset.mapZoom), 3, 19);
        render();
      }));
      map.querySelector("[data-map-current]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        const message = this.dialog.querySelector("#map-picker-message");
        if (!navigator.geolocation) {
          if (message) message.textContent = "当前浏览器不支持定位。";
          return;
        }
        if (message) message.textContent = "正在获取当前位置……";
        navigator.geolocation.getCurrentPosition((position) => {
          this.mapState.lat = position.coords.latitude;
          this.mapState.lng = position.coords.longitude;
          this.mapState.centerLat = position.coords.latitude;
          this.mapState.centerLng = position.coords.longitude;
          this.mapState.zoom = Math.max(this.mapState.zoom, 17);
          const accuracy = this.dialog.querySelector("#map-location-acc");
          if (accuracy) accuracy.value = String(Math.max(1, Math.round(position.coords.accuracy || 20)));
          if (message) message.textContent = `已定位，精度约 ${Math.round(position.coords.accuracy || 0)} 米。`;
          render();
        }, (error) => {
          if (message) message.textContent = error.code === 1 ? "未获得定位权限，请在浏览器中允许后重试。" : "暂时无法获取当前位置，请稍后重试。";
        }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
      });
      this.renderLocationMap = render;
      render();
    }

    currentUser(create = false) {
      let user = this.document.users.find((item) => item.username === this.username);
      if (!user && create) {
        user = {
          username: this.username,
          classes: this.classes,
          window_minutes: 20,
          courses: [],
          single_tasks: [],
          repeat_tasks: [],
        };
        this.document.users.push(user);
      }
      if (user) {
        user.courses = Array.isArray(user.courses) ? user.courses : [];
        normalizeCourseIds(user.courses);
        user.single_tasks = Array.isArray(user.single_tasks) ? user.single_tasks : [];
        user.repeat_tasks = Array.isArray(user.repeat_tasks) ? user.repeat_tasks : [];
        user.window_minutes = Number(user.window_minutes ?? 20);
      }
      return user;
    }

    locations() {
      return this.document.locations;
    }

    courseFor(id) {
      return this.currentUser(true).courses.find((course) => course.id === id);
    }

    taskTitle(task) {
      return this.courseFor(task.course_id)?.name || task.title || "未命名任务";
    }

    taskLocation(task) {
      return this.courseFor(task.course_id)?.location_group || task.location_group || "未选坐标";
    }

    taskInstances(day) {
      const user = this.currentUser(true);
      const target = dateFromKey(day);
      const weekday = target.getDay() === 0 ? 7 : target.getDay();
      const instances = [];
      user.single_tasks.forEach((task, index) => {
        if (task.date !== day) return;
        instances.push({
          type: "single",
          index,
          title: this.taskTitle(task),
          location: this.taskLocation(task),
          time: task.start_time || "08:00",
          enabled: task.enabled !== false,
        });
      });
      user.repeat_tasks.forEach((group, groupIndex) => {
        if (day < group.start_date || day > group.end_date) return;
        (group.occurrences ?? []).forEach((occurrence, occurrenceIndex) => {
          if (group.period === "weekly" && Number(occurrence.weekday) !== weekday) return;
          const instanceKey = `${day}#${occurrenceIndex}`;
          if ((group.excluded_instances ?? []).includes(instanceKey)) return;
          instances.push({
            type: "repeat",
            groupIndex,
            occurrenceIndex,
            instanceKey,
            title: this.taskTitle(group),
            location: this.taskLocation(group),
            time: occurrence.start_time || "08:00",
            enabled: group.enabled !== false,
          });
        });
      });
      return instances.sort((left, right) => left.time.localeCompare(right.time));
    }

    hasEnded(day, time) {
      const user = this.currentUser(true);
      const end = new Date(`${day}T${time || "08:00"}:00+08:00`);
      end.setMinutes(end.getMinutes() + Number(user.window_minutes || 20));
      return end < new Date();
    }

    navigate(value) {
      if (value === "today") {
        const now = new Date();
        this.cursor = new Date(now.getFullYear(), now.getMonth(), 1, 12);
        this.selectedDate = dateKey(now);
      } else {
        this.cursor = new Date(
          this.cursor.getFullYear(),
          this.cursor.getMonth() + Number(value),
          1,
          12,
        );
      }
      this.render();
    }

    render() {
      this.renderMonth();
      this.renderDay();
    }

    renderMonth() {
      const year = this.cursor.getFullYear();
      const month = this.cursor.getMonth();
      this.root.querySelector("#calendar-month-title").textContent = `${year} 年 ${month + 1} 月`;
      const first = new Date(year, month, 1, 12);
      const mondayOffset = (first.getDay() + 6) % 7;
      const start = new Date(year, month, 1 - mondayOffset, 12);
      const today = dateKey(new Date());
      const cells = [];
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        const key = dateKey(date);
        const tasks = this.taskInstances(key);
        const classNames = [
          "day-cell",
          date.getMonth() !== month ? "outside" : "",
          key === today ? "today" : "",
          key === this.selectedDate ? "selected" : "",
        ].filter(Boolean).join(" ");
        const chips = tasks.slice(0, 2).map((task) =>
          `<span class="task-chip ${task.enabled ? "" : "muted"}">${escapeHtml(task.time)} · ${escapeHtml(task.title)}</span>`
        ).join("");
        cells.push(`
          <button class="${classNames}" data-cal-date="${key}">
            <b>${date.getDate()}</b>
            <span class="cell-tasks">${chips}</span>
            ${tasks.length > 2 ? `<small>还有 ${tasks.length - 2} 项</small>` : ""}
          </button>
        `);
      }
      this.root.querySelector("#month-grid").innerHTML = cells.join("");
    }

    renderDay() {
      const date = dateFromKey(this.selectedDate);
      this.root.querySelector("#selected-date-title").textContent =
        `${date.getMonth() + 1} 月 ${date.getDate()} 日 · 周${WEEKDAYS[(date.getDay() + 6) % 7]}`;
      const tasks = this.taskInstances(this.selectedDate);
      const target = this.root.querySelector("#selected-task-list");
      if (!tasks.length) {
        target.innerHTML = '<div class="empty-day"><strong>今天很安静</strong><span>点“新任务”安排一次打卡。</span></div>';
        return;
      }
      target.innerHTML = tasks.map((task) => `
        <article class="day-task ${task.enabled ? "" : "disabled"}">
          <div class="task-time"><b>${escapeHtml(task.time)}</b><span>${this.hasEnded(this.selectedDate, task.time) ? "已结束" : "待进行"}</span></div>
          <div class="task-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.location)}</span></div>
          <div class="task-actions">
            ${task.type === "single"
              ? `<button data-cal-action="edit-single" data-index="${task.index}">编辑</button>
                 <button data-cal-action="delete-single" data-index="${task.index}">删除</button>`
              : `<button data-cal-action="detach-repeat" data-group-index="${task.groupIndex}" data-occurrence-index="${task.occurrenceIndex}">改单日</button>
                 <button data-cal-action="skip-repeat" data-group-index="${task.groupIndex}" data-instance-key="${task.instanceKey}">跳过</button>`}
          </div>
        </article>
      `).join("");
    }

    openDialog(mode, payload = null) {
      this.dialogMode = mode;
      this.dialogPayload = payload;
      this.renderDialog();
      const dialog = this.dialog;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }

    closeDialog() {
      const dialog = this.dialog;
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      this.dialogMode = null;
      this.dialogPayload = null;
    }

    dialogMeta(title, kicker = "日历工具") {
      this.dialog.querySelector("#calendar-dialog-title").textContent = title;
      this.dialog.querySelector("#calendar-dialog-kicker").textContent = kicker;
    }

    locationOptions(selected, disabled = false) {
      const options = ['<option value="">请选择坐标组</option>'];
      for (const group of this.locations()) {
        options.push(`<option value="${escapeHtml(group.name)}" ${group.name === selected ? "selected" : ""}>${escapeHtml(group.name)}</option>`);
      }
      return `<select data-cal-field="location_group" ${disabled ? "disabled" : ""}>${options.join("")}</select>`;
    }

    courseOptions(selected) {
      const options = ['<option value="">普通任务</option>'];
      for (const course of this.currentUser(true).courses) {
        options.push(`<option value="${escapeHtml(course.id)}" ${course.id === selected ? "selected" : ""}>${escapeHtml(course.name || "未命名课程")}</option>`);
      }
      return options.join("");
    }

    renderDialog() {
      const body = this.dialog.querySelector("#calendar-dialog-body");
      if (this.dialogMode === "locations") {
        this.dialogMeta("坐标组", "位置仓库");
        const selectedGroup = this.locations()[this.mapState.targetIndex];
        body.innerHTML = `
          <p class="dialog-help">点击地图选择位置并填写名称，然后直接新增到坐标组；已有坐标可在下方编辑。</p>
          <section class="map-picker-card">
            <div class="map-picker-head">
              <div><strong>地图选点</strong><small>拖动地图，单击放置蓝色标记</small></div>
              <span>准备新增坐标组</span>
            </div>
            <div class="location-map" id="location-map">
              <div class="map-tiles"></div>
              <div class="map-marker" aria-hidden="true"><i></i></div>
              <div class="map-controls">
                <button type="button" data-map-zoom="1" aria-label="放大地图">＋</button>
                <span class="map-zoom-label">Z${this.mapState.zoom}</span>
                <button type="button" data-map-zoom="-1" aria-label="缩小地图">−</button>
              </div>
              <button class="map-current-button" type="button" data-map-current>◎ 当前位置</button>
              <a class="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>
            </div>
            <div class="map-coordinate-form">
              <label>坐标组名称<input id="map-location-name" value="${escapeHtml(selectedGroup ? `${selectedGroup.name} 副本` : `地图坐标 ${this.locations().length + 1}`)}"></label>
              <label>纬度<input id="map-location-lat" type="number" step="0.00000001" value="${Number(this.mapState.lat).toFixed(8)}"></label>
              <label>经度<input id="map-location-lng" type="number" step="0.00000001" value="${Number(this.mapState.lng).toFixed(8)}"></label>
              <label>精度（米）<input id="map-location-acc" type="number" min="1" value="${selectedGroup?.location?.acc ?? 20}"></label>
            </div>
            <div class="map-picker-actions">
              <button class="button soft" type="button" data-cal-action="preview-map-draft">按输入坐标定位</button>
              <button class="button primary" type="button" data-cal-action="add-map-location">新增到坐标组</button>
            </div>
            <p class="map-picker-message" id="map-picker-message">地图坐标会保留 8 位小数。</p>
          </section>
          <div class="manual-location-head"><strong>现存坐标</strong><span>默认收起经纬度，点详情再编辑</span></div>
          <div class="editor-stack">
            ${this.locations().map((group, index) => `
              <div class="location-compact-card">
                <details>
                  <summary><strong>${escapeHtml(group.name)}</strong><span>查看详情</span></summary>
                  <div class="location-detail-grid">
                    <label>名称<input data-cal-kind="location" data-index="${index}" data-cal-field="name" data-original-name="${escapeHtml(group.name)}" value="${escapeHtml(group.name)}"></label>
                    <label>纬度<input type="number" step="0.00000001" data-cal-kind="location" data-index="${index}" data-cal-field="lat" value="${group.location?.lat ?? 0}"></label>
                    <label>经度<input type="number" step="0.00000001" data-cal-kind="location" data-index="${index}" data-cal-field="lng" value="${group.location?.lng ?? 0}"></label>
                    <label>精度<input type="number" min="1" data-cal-kind="location" data-index="${index}" data-cal-field="acc" value="${group.location?.acc ?? 20}"></label>
                  </div>
                </details>
                <div class="location-card-actions"><button class="cal-mini" data-cal-action="pick-location" data-index="${index}">在地图上定位</button><button class="danger-link" data-cal-action="delete-location" data-index="${index}">删除</button></div>
              </div>
            `).join("") || '<div class="empty-dialog">还没有坐标组。</div>'}
          </div>
          <button class="button soft" data-cal-action="add-location">＋ 手动新增空白组</button>
        `;
        requestAnimationFrame(() => this.mountLocationMap());
        return;
      }
      if (this.dialogMode === "courses") {
        this.dialogMeta("课程模板", "课程与坐标");
        body.innerHTML = `
          <p class="dialog-help">课程不绑定日期，只绑定名称和坐标。创建任务时选课程，坐标会保持只读。</p>
          <div class="editor-stack">
            ${this.currentUser(true).courses.map((course, index) => `
              <div class="editor-card course-card">
                <label>课程名称<input data-cal-kind="course" data-index="${index}" data-cal-field="name" value="${escapeHtml(course.name)}"></label>
                <label>固定坐标<select data-cal-kind="course" data-index="${index}" data-cal-field="location_group">
                  ${this.locationOptionsHtml(course.location_group)}
                </select></label>
                <button class="danger-link" data-cal-action="delete-course" data-index="${index}">删除</button>
              </div>
            `).join("") || '<div class="empty-dialog">先建一门课程，课表才有主角。</div>'}
          </div>
          <button class="button soft" data-cal-action="add-course">＋ 新增课程</button>
        `;
        return;
      }
      if (this.dialogMode === "singles") {
        const tasks = this.currentUser(true).single_tasks;
        this.dialogMeta("单次任务", "只发生一次");
        body.innerHTML = `
          <div class="task-library">
            ${tasks.map((task, index) => `
              <button class="library-row" data-cal-action="edit-single" data-index="${index}">
                <span><b>${escapeHtml(task.date)}</b><small>${escapeHtml(task.start_time)}</small></span>
                <strong>${escapeHtml(this.taskTitle(task))}</strong>
                <em>${task.enabled === false ? "已关闭" : escapeHtml(this.taskLocation(task))}</em>
              </button>
            `).join("") || '<div class="empty-dialog">没有单次任务。</div>'}
          </div>
          <button class="button soft" data-cal-action="add-single">＋ 新增单次任务</button>
        `;
        return;
      }
      if (this.dialogMode === "repeats") {
        const tasks = this.currentUser(true).repeat_tasks;
        this.dialogMeta("重复任务", "每天或每周");
        body.innerHTML = `
          <div class="task-library">
            ${tasks.map((task, index) => `
              <button class="library-row" data-cal-action="edit-repeat" data-index="${index}">
                <span><b>${task.period === "weekly" ? "每周" : "每天"}</b><small>${escapeHtml(task.start_date)} 起</small></span>
                <strong>${escapeHtml(this.taskTitle(task))}</strong>
                <em>${task.enabled === false ? "已关闭" : `${task.occurrences?.length ?? 0} 个时间`}</em>
              </button>
            `).join("") || '<div class="empty-dialog">没有重复任务。</div>'}
          </div>
          <button class="button soft" data-cal-action="add-repeat">＋ 新增重复任务</button>
        `;
        return;
      }
      if (this.dialogMode === "single-editor") {
        const index = Number(this.dialogPayload.index);
        const task = this.currentUser(true).single_tasks[index];
        const bound = Boolean(task.course_id);
        this.dialogMeta("编辑单次任务", task.date);
        body.innerHTML = `
          <div class="task-form">
            <label class="check-line"><input type="checkbox" data-cal-kind="single" data-index="${index}" data-cal-field="enabled" ${task.enabled !== false ? "checked" : ""}>启用打卡</label>
            <label>日期<input type="date" data-cal-kind="single" data-index="${index}" data-cal-field="date" value="${escapeHtml(task.date)}" ${this.dialogPayload.dateLocked ? "readonly" : ""}></label>
            <label>打卡时间<input type="time" data-cal-kind="single" data-index="${index}" data-cal-field="start_time" value="${escapeHtml(task.start_time || "08:00")}"></label>
            <label>任务类型<select data-cal-kind="single" data-index="${index}" data-cal-field="course_id">${this.courseOptions(task.course_id)}</select></label>
            <label>名称<input data-cal-kind="single" data-index="${index}" data-cal-field="title" value="${escapeHtml(this.taskTitle(task))}" ${bound ? "readonly" : ""}></label>
            <label>坐标组<select data-cal-kind="single" data-index="${index}" data-cal-field="location_group" ${bound ? "disabled" : ""}>${this.locationOptionsHtml(this.taskLocation(task))}</select></label>
          </div>
          <div class="dialog-footer"><button class="danger-link" data-cal-action="delete-single" data-index="${index}">删除任务</button><button class="button primary" data-cal-action="close-dialog">完成</button></div>
        `;
        return;
      }
      if (this.dialogMode === "repeat-editor") {
        const index = Number(this.dialogPayload.index);
        const task = this.currentUser(true).repeat_tasks[index];
        const bound = Boolean(task.course_id);
        this.dialogMeta("编辑重复任务", task.period === "weekly" ? "每周重复" : "每天重复");
        body.innerHTML = `
          <div class="task-form">
            <label class="check-line"><input type="checkbox" data-cal-kind="repeat" data-index="${index}" data-cal-field="enabled" ${task.enabled !== false ? "checked" : ""}>启用打卡</label>
            <label>重复周期<select data-cal-kind="repeat" data-index="${index}" data-cal-field="period"><option value="daily" ${task.period !== "weekly" ? "selected" : ""}>每天</option><option value="weekly" ${task.period === "weekly" ? "selected" : ""}>每周</option></select></label>
            <label>开始日期<input type="date" data-cal-kind="repeat" data-index="${index}" data-cal-field="start_date" value="${escapeHtml(task.start_date)}"></label>
            <label>截止日期<input type="date" data-cal-kind="repeat" data-index="${index}" data-cal-field="end_date" value="${escapeHtml(task.end_date)}"></label>
            <label>任务类型<select data-cal-kind="repeat" data-index="${index}" data-cal-field="course_id">${this.courseOptions(task.course_id)}</select></label>
            <label>名称<input data-cal-kind="repeat" data-index="${index}" data-cal-field="title" value="${escapeHtml(this.taskTitle(task))}" ${bound ? "readonly" : ""}></label>
            <label>坐标组<select data-cal-kind="repeat" data-index="${index}" data-cal-field="location_group" ${bound ? "disabled" : ""}>${this.locationOptionsHtml(this.taskLocation(task))}</select></label>
          </div>
          <div class="occurrence-list">
            <strong>周期内时间</strong>
            ${(task.occurrences ?? []).map((occurrence, occurrenceIndex) => `
              <div class="occurrence-row">
                ${task.period === "weekly" ? `<select data-cal-kind="occurrence" data-index="${index}" data-occurrence="${occurrenceIndex}" data-cal-field="weekday">${WEEKDAY_OPTIONS.map((label, day) => `<option value="${day + 1}" ${Number(occurrence.weekday) === day + 1 ? "selected" : ""}>${label}</option>`).join("")}</select>` : '<span>每天</span>'}
                <input type="time" data-cal-kind="occurrence" data-index="${index}" data-occurrence="${occurrenceIndex}" data-cal-field="start_time" value="${escapeHtml(occurrence.start_time || "08:00")}">
                <button data-cal-action="delete-occurrence" data-index="${index}" data-occurrence="${occurrenceIndex}">删除</button>
              </div>
            `).join("")}
            <button class="cal-mini" data-cal-action="add-occurrence" data-index="${index}">＋ 添加时间</button>
          </div>
          <div class="dialog-footer"><button class="danger-link" data-cal-action="delete-repeat" data-index="${index}">删除任务</button><button class="button primary" data-cal-action="close-dialog">完成</button></div>
        `;
      }
    }

    locationOptionsHtml(selected) {
      return ['<option value="">请选择坐标组</option>', ...this.locations().map((group) =>
        `<option value="${escapeHtml(group.name)}" ${group.name === selected ? "selected" : ""}>${escapeHtml(group.name)}</option>`
      )].join("");
    }

    newSingle(date = this.selectedDate) {
      return {
        id: makeId("single"),
        enabled: true,
        title: "新任务",
        date,
        start_time: "08:00",
        location_group: this.locations()[0]?.name ?? "",
        course_id: "",
      };
    }

    newRepeat() {
      const start = this.selectedDate;
      const end = dateFromKey(start);
      end.setDate(end.getDate() + 30);
      return {
        id: makeId("repeat"),
        enabled: true,
        title: "新重复任务",
        location_group: this.locations()[0]?.name ?? "",
        period: "weekly",
        start_date: start,
        end_date: dateKey(end),
        occurrences: [{ weekday: dateFromKey(start).getDay() || 7, start_time: "08:00" }],
        excluded_instances: [],
        course_id: "",
      };
    }

    handleAction(action, data) {
      const user = this.currentUser(true);
      if (action === "close-dialog") return this.closeDialog();
      if (action === "preview-map-draft") {
        try {
          const draft = this.mapDraft();
          this.mapState.lat = draft.location.lat;
          this.mapState.lng = draft.location.lng;
          this.mapState.centerLat = draft.location.lat;
          this.mapState.centerLng = draft.location.lng;
          this.renderLocationMap?.();
          this.dialog.querySelector("#map-picker-message").textContent = "已定位到输入坐标，确认后再应用。";
        } catch (error) {
          this.dialog.querySelector("#map-picker-message").textContent = error.message;
        }
        return;
      }
      if (action === "pick-location") {
        this.selectLocationOnMap(Number(data.index));
        this.renderDialog();
        return;
      }
      if (action === "add-map-location") {
        try {
          const draft = this.mapDraft();
          if (this.locations().some((group) => group.name === draft.name)) {
            throw new Error("该坐标组名称已存在，请换一个名称");
          }
          this.locations().push(draft);
          this.mapState.targetIndex = null;
          this.mapState.lat = draft.location.lat;
          this.mapState.lng = draft.location.lng;
          this.mapState.centerLat = draft.location.lat;
          this.mapState.centerLng = draft.location.lng;
          this.changed();
          this.render();
          this.renderDialog();
        } catch (error) {
          this.dialog.querySelector("#map-picker-message").textContent = error.message;
        }
        return;
      }
      if (action === "new-day-task") {
        user.single_tasks.push(this.newSingle());
        this.changed();
        return this.openDialog("single-editor", { index: user.single_tasks.length - 1, dateLocked: true });
      }
      if (action === "add-location") {
        this.locations().push({ name: `坐标组 ${this.locations().length + 1}`, location: { lat: 0, lng: 0, acc: 20 } });
      } else if (action === "delete-location") {
        const removedIndex = Number(data.index);
        const [removed] = this.locations().splice(removedIndex, 1);
        if (this.mapState.targetIndex === removedIndex) this.mapState.targetIndex = null;
        else if (this.mapState.targetIndex > removedIndex) this.mapState.targetIndex -= 1;
        if (removed) {
          [...user.courses, ...user.single_tasks, ...user.repeat_tasks].forEach((item) => {
            if (item.location_group === removed.name) item.location_group = "";
          });
        }
      } else if (action === "add-course") {
        user.courses.push({ id: makeId("course"), name: `课程 ${user.courses.length + 1}`, location_group: this.locations()[0]?.name ?? "" });
      } else if (action === "delete-course") {
        const [removed] = user.courses.splice(Number(data.index), 1);
        if (removed) [...user.single_tasks, ...user.repeat_tasks].forEach((task) => {
          if (task.course_id === removed.id) {
            task.course_id = "";
            task.title ||= removed.name;
            task.location_group ||= removed.location_group;
          }
        });
      } else if (action === "add-single") {
        user.single_tasks.push(this.newSingle());
        this.changed();
        return this.openDialog("single-editor", { index: user.single_tasks.length - 1, dateLocked: false });
      } else if (action === "edit-single") {
        return this.openDialog("single-editor", { index: Number(data.index), dateLocked: this.dialogMode === null });
      } else if (action === "delete-single") {
        user.single_tasks.splice(Number(data.index), 1);
        this.closeDialog();
      } else if (action === "add-repeat") {
        user.repeat_tasks.push(this.newRepeat());
        this.changed();
        return this.openDialog("repeat-editor", { index: user.repeat_tasks.length - 1 });
      } else if (action === "edit-repeat") {
        return this.openDialog("repeat-editor", { index: Number(data.index) });
      } else if (action === "delete-repeat") {
        user.repeat_tasks.splice(Number(data.index), 1);
        this.closeDialog();
      } else if (action === "add-occurrence") {
        user.repeat_tasks[Number(data.index)].occurrences.push({ weekday: 1, start_time: "08:00" });
      } else if (action === "delete-occurrence") {
        user.repeat_tasks[Number(data.index)].occurrences.splice(Number(data.occurrence), 1);
      } else if (action === "skip-repeat") {
        const group = user.repeat_tasks[Number(data.groupIndex)];
        group.excluded_instances ??= [];
        if (!group.excluded_instances.includes(data.instanceKey)) group.excluded_instances.push(data.instanceKey);
      } else if (action === "detach-repeat") {
        const group = user.repeat_tasks[Number(data.groupIndex)];
        const occurrenceIndex = Number(data.occurrenceIndex);
        const occurrence = group.occurrences[occurrenceIndex];
        const key = `${this.selectedDate}#${occurrenceIndex}`;
        group.excluded_instances ??= [];
        if (!group.excluded_instances.includes(key)) group.excluded_instances.push(key);
        user.single_tasks.push({
          id: makeId("single"),
          enabled: group.enabled !== false,
          title: this.taskTitle(group),
          date: this.selectedDate,
          start_time: occurrence.start_time,
          location_group: this.taskLocation(group),
          course_id: group.course_id || "",
        });
        this.changed();
        return this.openDialog("single-editor", { index: user.single_tasks.length - 1, dateLocked: true });
      } else {
        return;
      }
      this.changed();
      this.render();
      if (this.dialogMode) this.renderDialog();
    }

    updateField(input, notify = true) {
      const kind = input.dataset.calKind;
      const index = Number(input.dataset.index);
      const field = input.dataset.calField;
      if (!kind || !field) return;
      let target;
      if (kind === "location") {
        target = field === "name" ? this.locations()[index] : this.locations()[index].location;
      } else if (kind === "course") {
        target = this.currentUser(true).courses[index];
      } else if (kind === "single") {
        target = this.currentUser(true).single_tasks[index];
      } else if (kind === "repeat") {
        target = this.currentUser(true).repeat_tasks[index];
      } else if (kind === "occurrence") {
        target = this.currentUser(true).repeat_tasks[index].occurrences[Number(input.dataset.occurrence)];
      }
      if (!target) return;
      let value = input.type === "checkbox" ? input.checked : input.value;
      if (["lat", "lng", "acc", "weekday"].includes(field)) value = Number(value);
      target[field] = value;
      if ((kind === "single" || kind === "repeat") && field === "course_id" && value) {
        const course = this.courseFor(value);
        if (course) {
          target.title = course.name;
          target.location_group = course.location_group;
        }
      }
      if (notify) this.changed();
    }

    handleChange(input) {
      if (!input.matches("[data-cal-field]")) return;
      const previousLocationName = input.dataset.originalName;
      this.updateField(input);
      if (previousLocationName !== undefined) {
        const nextName = input.value.trim();
        input.dataset.originalName = nextName;
        const user = this.currentUser(true);
        [...user.courses, ...user.single_tasks, ...user.repeat_tasks].forEach((item) => {
          if (item.location_group === previousLocationName) item.location_group = nextName;
        });
      }
      this.render();
      if (
        ["course_id", "period"].includes(input.dataset.calField) ||
        input.dataset.calKind === "course"
      ) {
        this.renderDialog();
      }
    }

    changed() {
      this.onChange?.(this.getDocument());
    }
  }

  window.CalendarUI = {
    create(root, onChange) {
      return new CalendarEditor(
        typeof root === "string" ? document.querySelector(root) : root,
        onChange,
      );
    },
  };
})();
