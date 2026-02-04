(() => {
  const DATA = window.SUBWAY_DATA;
  const levels = DATA.meta.levels;
  const grid = DATA.meta.grid;
  const stations = DATA.stations;
  const stationNodes = DATA.stationNodes;
  const nodes = DATA.nodes;
  const edges = DATA.edges;
  const lineColors = DATA.lineColors;

  const image = document.getElementById("map-image");
  const canvas = document.getElementById("contours");
  const svg = document.getElementById("stations");
  const searchInput = document.getElementById("station-search");
  const datalist = document.getElementById("station-list");
  const labelToggle = document.getElementById("label-toggle");
  const randomBtn = document.getElementById("random-btn");
  const activeStationBadge = document.getElementById("active-station");
  const activeLines = document.getElementById("active-lines");
  const stats = document.getElementById("stats");
  const debugPanel = document.getElementById("debug");
  const legend = document.getElementById("legend");

  const stationByName = new Map(stations.map((s) => [s.name, s]));
  const stationNames = stations.map((s) => s.name);
  const stationTimeLabels = new Map();
  const levelFills = [];

  const contourCanvas = canvas.getContext("2d");
  let displayScale = 1;
  let drawScale = { x: 1, y: 1 };
  let latestContours = null;
  let displaySize = { width: 1, height: 1 };
  let animationToken = 0;
  let stationTimeList = [];
  let stationTimeIndex = 0;
  let fieldValues = null;
  let fieldStep = { x: 1, y: 1 };
  let startCell = [0, 0];

  const AUTO_SCALE = false;

  const palette = levels.map((level, idx) => {
    const t = idx / Math.max(1, levels.length - 1);
    const hue = 210 - 170 * t;
    return `hsl(${hue}, 70%, 48%)`;
  });

  function buildLegend() {
    legend.innerHTML = "";
    levels.forEach((level, idx) => {
      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.style.background = palette[idx];
      const label = document.createElement("div");
      label.textContent = `${level} 分钟`;
      legend.appendChild(swatch);
      legend.appendChild(label);
    });
  }

  function createStations() {
    svg.setAttribute("viewBox", `0 0 ${DATA.meta.imageWidth} ${DATA.meta.imageHeight}`);
    svg.innerHTML = "";
    stations.forEach((station) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.classList.add("station-group");
      group.dataset.station = station.name;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", station.x);
      circle.setAttribute("cy", station.y);
      circle.setAttribute("r", station.r);
      circle.classList.add("station-dot");
      if (station.isTransfer) circle.classList.add("transfer");

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", station.x + station.r + 6);
      label.setAttribute("y", station.y - station.r - 4);
      label.textContent = station.name;
      label.classList.add("station-label");

      const timeLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      timeLabel.setAttribute("x", station.x);
      timeLabel.setAttribute("y", station.y);
      timeLabel.textContent = "";
      timeLabel.classList.add("station-time");
      timeLabel.style.display = "none";

      group.appendChild(circle);
      group.appendChild(label);
      group.appendChild(timeLabel);
      group.addEventListener("click", () => selectStation(station.name));
      svg.appendChild(group);
      stationTimeLabels.set(station.name, timeLabel);
    });
  }

  function updateLabelVisibility() {
    const show = labelToggle.checked;
    svg.querySelectorAll(".station-label").forEach((label) => {
      label.style.display = show ? "block" : "none";
    });
  }

  class MinHeap {
    constructor() { this.data = []; }
    push(item) {
      this.data.push(item);
      this.bubbleUp(this.data.length - 1);
    }
    bubbleUp(index) {
      const data = this.data;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (data[parent][0] <= data[index][0]) break;
        [data[parent], data[index]] = [data[index], data[parent]];
        index = parent;
      }
    }
    pop() {
      if (this.data.length === 0) return null;
      const top = this.data[0];
      const last = this.data.pop();
      if (this.data.length > 0 && last) {
        this.data[0] = last;
        this.sinkDown(0);
      }
      return top;
    }
    sinkDown(index) {
      const data = this.data;
      const length = data.length;
      while (true) {
        let left = 2 * index + 1;
        let right = 2 * index + 2;
        let smallest = index;
        if (left < length && data[left][0] < data[smallest][0]) smallest = left;
        if (right < length && data[right][0] < data[smallest][0]) smallest = right;
        if (smallest === index) break;
        [data[smallest], data[index]] = [data[index], data[smallest]];
        index = smallest;
      }
    }
    get size() { return this.data.length; }
  }

  function gaussianBlur(values, cols, rows, radius) {
    if (radius < 1) return values;

    const size = cols * rows;
    const newValues = new Float32Array(size);
    // 生成高斯核
    const sigma = radius / 2;
    const kernelWidth = 2 * radius + 1;
    const kernel = new Float32Array(kernelWidth * kernelWidth);
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const weight = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
        kernel[(y + radius) * kernelWidth + (x + radius)] = weight;
        sum += weight;
      }
    }
    // 归一化核
    for (let i = 0; i < kernel.length; i++) {
      kernel[i] /= sum;
    }

    // 应用高斯核
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let val = 0;
        let weightSum = 0;
        for (let ky = -radius; ky <= radius; ky++) {
          const py = y + ky;
          if (py < 0 || py >= rows) continue; // 边界检查
          for (let kx = -radius; kx <= radius; kx++) {
            const px = x + kx;
            if (px < 0 || px >= cols) continue; // 边界检查

            const weight = kernel[(ky + radius) * kernelWidth + (kx + radius)];
            val += values[py * cols + px] * weight;
            weightSum += weight;
          }
        }
        // 对于边界点，需要重新归一化权重
        newValues[y * cols + x] = val / weightSum;
      }
    }
    return newValues;
  }

  function dijkstra(startStation) {
    const dist = Array(nodes.length).fill(Infinity);
    const heap = new MinHeap();
    const starts = (stationNodes[startStation] || []).map((idx) => Number(idx));
    starts.forEach((idx) => {
      if (!Number.isFinite(idx)) return;
      dist[idx] = 0;
      heap.push([0, idx]);
    });
    let relaxCount = 0;
    let popCount = 0;
    while (heap.size > 0) {
      const current = heap.pop();
      if (!current) break;
      const d = Number(current[0]);
      const u = Number(current[1]);
      if (!Number.isFinite(d) || !Number.isFinite(u)) continue;
      popCount += 1;
      if (d > dist[u] + 1e-9) continue;
      const neighbors = edges[u];
      for (let i = 0; i < neighbors.length; i++) {
        const v = Number(neighbors[i][0]);
        const w = Number(neighbors[i][1]);
        if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          heap.push([nd, v]);
          relaxCount += 1;
        }
      }
    }
    const stationTimes = new Map();
    Object.keys(stationNodes).forEach((name) => {
      let min = Infinity;
      stationNodes[name].forEach((idx) => {
        if (dist[idx] < min) min = dist[idx];
      });
      if (min < Infinity) stationTimes.set(name, min);
    });
    return { stationTimes, popCount, relaxCount, dist, starts };
  }

  function scaleStationTimes(stationTimes) {
    if (!AUTO_SCALE) return { times: stationTimes, scale: 1 };
    const rawTimes = Array.from(stationTimes.values());
    if (rawTimes.length === 0) return { times: stationTimes, scale: 1 };
    const maxLevel = levels[levels.length - 1];
    const maxTime = Math.max(...rawTimes);
    if (!Number.isFinite(maxTime) || maxTime <= maxLevel) {
      return { times: stationTimes, scale: 1 };
    }
    const scale = maxLevel / maxTime;
    const scaled = new Map();
    stationTimes.forEach((value, key) => {
      scaled.set(key, value * scale);
    });
    return { times: scaled, scale };
  }

  function computeField(stationTimes) {
    const cols = grid.cols;
    const rows = grid.rows;
    const values = new Float32Array(cols * rows);
    const stepX = DATA.meta.imageWidth / (cols - 1);
    const stepY = DATA.meta.imageHeight / (rows - 1);

    const coordStations = stations
      .map((s) => ({ s, t: stationTimes.get(s.name) }))
      .filter((s) => s.t !== undefined && Number.isFinite(s.t));

    const xs = new Float32Array(coordStations.length);
    const ys = new Float32Array(coordStations.length);
    const ts = new Float32Array(coordStations.length);
    coordStations.forEach((item, i) => {
      xs[i] = item.s.x;
      ys[i] = item.s.y;
      ts[i] = item.t;
    });

    for (let y = 0; y < rows; y++) {
      const mapY = y * stepY;
      for (let x = 0; x < cols; x++) {
        const mapX = x * stepX;
        let num = 0;
        let den = 0;
        for (let i = 0; i < xs.length; i++) {
          const dx = mapX - xs[i];
          const dy = mapY - ys[i];
          // const d2 = dx * dx + dy * dy + 1;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const power = 10; // 试试 1.5 或 1.2
          const w = 1 / (Math.pow(dist, power) + 1);
          // const w = 1 / d2;
          num += w * ts[i];
          den += w;
        }
        values[y * cols + x] = num / den;
      }
    }
    return { values, stepX, stepY };
  }

  function buildLevelFill(values, level, prevLevel, startCell) {
    const cols = grid.cols;
    const rows = grid.rows;
    const idx = (x, y) => y * cols + x;
    const inBounds = (x, y) => x >= 0 && x < cols && y >= 0 && y < rows;
    const threshold = level;
    const visited = new Uint8Array(cols * rows);
    const qx = new Int32Array(cols * rows);
    const qy = new Int32Array(cols * rows);
    let qh = 0;
    let qt = 0;
    const sx = startCell[0];
    const sy = startCell[1];
    if (!inBounds(sx, sy)) return null;
    if (!(values[idx(sx, sy)] <= threshold)) return null;
    visited[idx(sx, sy)] = 1;
    qx[qt] = sx;
    qy[qt] = sy;
    qt += 1;
    while (qh < qt) {
      const x = qx[qh];
      const y = qy[qh];
      qh += 1;
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1]
      ];
      for (let i = 0; i < neighbors.length; i++) {
        const nx = neighbors[i][0];
        const ny = neighbors[i][1];
        if (!inBounds(nx, ny)) continue;
        const id = idx(nx, ny);
        if (visited[id]) continue;
        if (values[id] > threshold) continue;
        visited[id] = 1;
        qx[qt] = nx;
        qy[qt] = ny;
        qt += 1;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const hue = 210 - 170 * (levels.indexOf(level) / Math.max(1, levels.length - 1));
    const color = `hsla(${hue}, 70%, 55%, 0.22)`;
    ctx.fillStyle = color;
    const lower = prevLevel == null ? -Infinity : prevLevel;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!visited[idx(x, y)]) continue;
        const v = values[idx(x, y)];
        if (v > lower && v <= threshold) ctx.fillRect(x, y, 1, 1);
      }
    }
    return canvas;
  }

  function computeConnectedMask(values, threshold, startCell) {
    const cols = grid.cols;
    const rows = grid.rows;
    const idx = (x, y) => y * cols + x;
    const inBounds = (x, y) => x >= 0 && x < cols && y >= 0 && y < rows;
    const visited = new Uint8Array(cols * rows);
    const qx = new Int32Array(cols * rows);
    const qy = new Int32Array(cols * rows);
    let qh = 0;
    let qt = 0;
    const sx = startCell[0];
    const sy = startCell[1];
    if (!inBounds(sx, sy)) return null;
    if (!(values[idx(sx, sy)] <= threshold)) return null;
    visited[idx(sx, sy)] = 1;
    qx[qt] = sx;
    qy[qt] = sy;
    qt += 1;
    while (qh < qt) {
      const x = qx[qh];
      const y = qy[qh];
      qh += 1;
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1]
      ];
      for (let i = 0; i < neighbors.length; i++) {
        const nx = neighbors[i][0];
        const ny = neighbors[i][1];
        if (!inBounds(nx, ny)) continue;
        const id = idx(nx, ny);
        if (visited[id]) continue;
        if (values[id] > threshold) continue;
        visited[id] = 1;
        qx[qt] = nx;
        qy[qt] = ny;
        qt += 1;
      }
    }
    return visited;
  }

  function bandIndex(value) {
    if (value <= levels[0]) return 0;
    for (let i = 1; i < levels.length; i++) {
      if (value <= levels[i]) return i;
    }
    return levels.length - 1;
  }

  function prepareLevelFills(values, startStation) {
    levelFills.length = 0;
    const stepX = DATA.meta.imageWidth / (grid.cols - 1);
    const stepY = DATA.meta.imageHeight / (grid.rows - 1);
    const start = stationByName.get(startStation);
    if (!start) return;
    const sx = Math.max(0, Math.min(grid.cols - 1, Math.round(start.x / stepX)));
    const sy = Math.max(0, Math.min(grid.rows - 1, Math.round(start.y / stepY)));
    startCell = [sx, sy];
    fieldValues = values;
    fieldStep = { x: stepX, y: stepY };
    levels.forEach((level, i) => {
      const prev = i === 0 ? null : levels[i - 1];
      levelFills.push(buildLevelFill(values, level, prev, [sx, sy]));
    });
  }

  function interpolate(p1, p2, v1, v2, threshold) {
    const t = (threshold - v1) / (v2 - v1);
    return p1 + t * (p2 - p1);
  }

  function marchingSquares(values, cols, rows, threshold) {
    const segments = [];
    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < cols - 1; x++) {
        const i = y * cols + x;
        const v0 = values[i];
        const v1 = values[i + 1];
        const v2 = values[i + cols + 1];
        const v3 = values[i + cols];

        const c0 = v0 >= threshold ? 1 : 0;
        const c1 = v1 >= threshold ? 1 : 0;
        const c2 = v2 >= threshold ? 1 : 0;
        const c3 = v3 >= threshold ? 1 : 0;
        const code = c0 | (c1 << 1) | (c2 << 2) | (c3 << 3);
        if (code === 0 || code === 15) continue;

        const top = interpolate(x, x + 1, v0, v1, threshold);
        const right = interpolate(y, y + 1, v1, v2, threshold);
        const bottom = interpolate(x, x + 1, v3, v2, threshold);
        const left = interpolate(y, y + 1, v0, v3, threshold);

        const add = (x1, y1, x2, y2) => segments.push([x1, y1, x2, y2]);

        switch (code) {
          case 1:
            add(x, left, top, y);
            break;
          case 2:
            add(top, y, x + 1, right);
            break;
          case 3:
            add(x, left, x + 1, right);
            break;
          case 4:
            add(x + 1, right, bottom, y + 1);
            break;
          case 5: {
            const center = (v0 + v1 + v2 + v3) / 4;
            if (center >= threshold) {
              add(x, left, bottom, y + 1);
              add(top, y, x + 1, right);
            } else {
              add(x, left, top, y);
              add(bottom, y + 1, x + 1, right);
            }
            break;
          }
          case 6:
            add(top, y, bottom, y + 1);
            break;
          case 7:
            add(x, left, bottom, y + 1);
            break;
          case 8:
            add(x, left, bottom, y + 1);
            break;
          case 9:
            add(top, y, bottom, y + 1);
            break;
          case 10: {
            const center = (v0 + v1 + v2 + v3) / 4;
            if (center >= threshold) {
              add(x, left, top, y);
              add(bottom, y + 1, x + 1, right);
            } else {
              add(x, left, bottom, y + 1);
              add(top, y, x + 1, right);
            }
            break;
          }
          case 11:
            add(x + 1, right, bottom, y + 1);
            break;
          case 12:
            add(x, left, x + 1, right);
            break;
          case 13:
            add(top, y, x + 1, right);
            break;
          case 14:
            add(x, left, top, y);
            break;
          default:
            break;
        }
      }
    }
    return segments;
  }

  function buildContours(values) {
    const blurredValues = gaussianBlur(
      values,
      grid.cols,
      grid.rows,
      1 // 模糊半径，可以根据效果调整
    );
    const contourMap = new Map();
    levels.forEach((level) => {
      contourMap.set(level, marchingSquares(blurredValues, grid.cols, grid.rows, level));
    });
    return contourMap;
  }

  function resizeCanvas() {
    const rect = image.getBoundingClientRect();
    displaySize = { width: rect.width, height: rect.height };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    contourCanvas.setTransform(dpr, 0, 0, dpr, 0, 0);
    displayScale = rect.width / DATA.meta.imageWidth;
    drawScale = {
      x: (DATA.meta.imageWidth / (grid.cols - 1)) * displayScale,
      y: (DATA.meta.imageHeight / (grid.rows - 1)) * displayScale
    };
    if (latestContours) drawContours(latestContours, 1);
  }

  function drawContours(contours, alpha = 1) {
    contourCanvas.clearRect(0, 0, canvas.width, canvas.height);
    levels.forEach((level, idx) => {
      const segs = contours.get(level) || [];
      contourCanvas.lineWidth = 2.2;
      contourCanvas.strokeStyle = palette[idx];
      contourCanvas.globalAlpha = alpha;
      contourCanvas.beginPath();
      for (let i = 0; i < segs.length; i++) {
        const [x1, y1, x2, y2] = segs[i];
        contourCanvas.moveTo(x1 * drawScale.x, y1 * drawScale.y);
        contourCanvas.lineTo(x2 * drawScale.x, y2 * drawScale.y);
      }
      contourCanvas.stroke();
      contourCanvas.globalAlpha = 1;
    });
  }

  function drawContoursUpTo(contours, uptoIndex, currentAlpha = 1) {
    contourCanvas.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i <= uptoIndex; i++) {
      const level = levels[i];
      const segs = contours.get(level) || [];
      const alpha = (i === uptoIndex) ? currentAlpha : 1;
      contourCanvas.lineWidth = 2.2;
      contourCanvas.strokeStyle = palette[i];
      contourCanvas.globalAlpha = alpha;
      contourCanvas.beginPath();
      for (let j = 0; j < segs.length; j++) {
        const [x1, y1, x2, y2] = segs[j];
        contourCanvas.moveTo(x1 * drawScale.x, y1 * drawScale.y);
        contourCanvas.lineTo(x2 * drawScale.x, y2 * drawScale.y);
      }
      contourCanvas.stroke();
      contourCanvas.globalAlpha = 1;
    }
  }

  function drawContoursProgress(contours, currentMinute) {
    contourCanvas.clearRect(0, 0, canvas.width, canvas.height);
    if (!fieldValues) return;
    const currentBand = bandIndex(currentMinute);
    const prevLevel = currentBand === 0 ? null : levels[currentBand - 1];

    // Draw completed bands
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      if (level > currentMinute) continue;
      const fill = levelFills[i];
      if (!fill) continue;
      contourCanvas.save();
      contourCanvas.globalAlpha = 0.7;
      contourCanvas.imageSmoothingEnabled = true;
      contourCanvas.drawImage(fill, 0, 0, displaySize.width, displaySize.height);
      contourCanvas.restore();
    }

    // Draw partial fill for current band (continuous expansion)
    const mask = computeConnectedMask(fieldValues, currentMinute, startCell);
    if (mask) {
      const cols = grid.cols;
      const rows = grid.rows;
      const idx = (x, y) => y * cols + x;
      const partial = document.createElement("canvas");
      partial.width = cols;
      partial.height = rows;
      const pctx = partial.getContext("2d");
      if (pctx) {
        const hue = 210 - 170 * (currentBand / Math.max(1, levels.length - 1));
        pctx.fillStyle = `hsla(${hue}, 70%, 55%, 0.22)`;
        const lower = prevLevel == null ? -Infinity : prevLevel;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            if (!mask[idx(x, y)]) continue;
            const v = fieldValues[idx(x, y)];
            if (v > lower && v <= currentMinute) pctx.fillRect(x, y, 1, 1);
          }
        }
        contourCanvas.save();
        contourCanvas.globalAlpha = 0.7;
        contourCanvas.imageSmoothingEnabled = true;
        contourCanvas.drawImage(partial, 0, 0, displaySize.width, displaySize.height);
        contourCanvas.restore();
      }
    }

    // Draw completed contour lines at thresholds
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      if (level > currentMinute) continue;
      const segs = contours.get(level) || [];
      if (segs.length === 0) continue;
      contourCanvas.lineWidth = 2.2;
      contourCanvas.strokeStyle = palette[i];
      contourCanvas.globalAlpha = 1;
      contourCanvas.beginPath();
      for (let j = 0; j < segs.length; j++) {
        const [x1, y1, x2, y2] = segs[j];
        contourCanvas.moveTo(x1 * drawScale.x, y1 * drawScale.y);
        contourCanvas.lineTo(x2 * drawScale.x, y2 * drawScale.y);
      }
      contourCanvas.stroke();
      contourCanvas.globalAlpha = 1;
    }

    // Draw current expanding contour
    let segs = [];
    if (mask) {
      const masked = new Float32Array(fieldValues.length);
      for (let i = 0; i < fieldValues.length; i++) {
        masked[i] = mask[i] ? fieldValues[i] : (currentMinute + 1000);
      }
      segs = marchingSquares(masked, grid.cols, grid.rows, currentMinute);
    } else {
      segs = marchingSquares(fieldValues, grid.cols, grid.rows, currentMinute);
    }
    if (segs.length > 0) {
      contourCanvas.lineWidth = 2.6;
      contourCanvas.strokeStyle = palette[currentBand];
      contourCanvas.globalAlpha = 0.9;
      contourCanvas.beginPath();
      for (let j = 0; j < segs.length; j++) {
        const [x1, y1, x2, y2] = segs[j];
        contourCanvas.moveTo(x1 * drawScale.x, y1 * drawScale.y);
        contourCanvas.lineTo(x2 * drawScale.x, y2 * drawScale.y);
      }
      contourCanvas.stroke();
      contourCanvas.globalAlpha = 1;
    }
  }

  function animateExpansion(contours) {
    const token = ++animationToken;
    const maxLevel = levels[levels.length - 1];
    const duration = 7000;
    const start = performance.now();

    function frame(now) {
      if (token !== animationToken) return;
      const t = Math.min(1, (now - start) / duration);
      const currentMinute = maxLevel * t;
      revealStationsUpTo(currentMinute);
      drawContoursProgress(contours, currentMinute);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        revealStationsUpTo(maxLevel);
        drawContoursProgress(contours, maxLevel);
      }
    }
    requestAnimationFrame(frame);
  }

  function updateActiveStation(name) {
    svg.querySelectorAll(".station-dot").forEach((el) => el.classList.remove("active"));
    svg.querySelectorAll(".station-dot").forEach((el) => el.classList.remove("reached"));
    const station = stationByName.get(name);
    if (!station) return;
    const group = svg.querySelector(`[data-station="${CSS.escape(name)}"]`);
    if (group) {
      const circle = group.querySelector(".station-dot");
      if (circle) circle.classList.add("active");
    }
    activeStationBadge.textContent = name;
    activeLines.innerHTML = station.lines.map((line) => {
      const color = lineColors[line] || "#333";
      return `<span class="badge" style="background:${color}20;color:${color}">${line}</span>`;
    }).join(" ");
  }

  function prepareStationTimes(stationTimes) {
    stationTimeList = Array.from(stationTimes.entries())
      .filter(([, t]) => Number.isFinite(t))
      .sort((a, b) => a[1] - b[1]);
    stationTimeIndex = 0;
    stationTimeLabels.forEach((label) => {
      label.textContent = "";
      label.style.display = "none";
    });
  }

  function revealStationsUpTo(limitMinutes) {
    while (stationTimeIndex < stationTimeList.length) {
      const [name, time] = stationTimeList[stationTimeIndex];
      if (time > limitMinutes) break;
      const label = stationTimeLabels.get(name);
      if (label) {
        label.textContent = `${time.toFixed(0)}m`;
        label.style.display = "inline";
      }
      const group = svg.querySelector(`[data-station="${CSS.escape(name)}"]`);
      if (group) {
        const circle = group.querySelector(".station-dot");
        if (circle) circle.classList.add("reached");
      }
      stationTimeIndex += 1;
    }
  }

  function selectStation(name) {
    const station = stationByName.get(name);
    if (!station) return;
    updateActiveStation(name);
    stats.textContent = "计算等时线中...";
    const result = dijkstra(name);
    const stationTimes = result.stationTimes;
    if (stationTimes.size === 0) {
      stats.textContent = "当前站点无法计算等时线，请检查数据。";
      return;
    }
    const scaledInfo = scaleStationTimes(stationTimes);
    const timesForDisplay = scaledInfo.times;
    const values = Array.from(timesForDisplay.values());
    const reachable = values.filter((t) => t < Infinity).length;
    const maxTime = Math.max(...values);
    const maxLevel = levels[levels.length - 1];
    const withinMax = values.filter((t) => t <= maxLevel).length;
    const totalStations = Object.keys(stationNodes).length;
    const startNodes = (stationNodes[name] || []).length;
    const totalEdges = edges.reduce((sum, list) => sum + (list ? list.length : 0), 0);
    const nodesWithEdges = edges.reduce((sum, list) => sum + ((list && list.length > 0) ? 1 : 0), 0);
    const startDegrees = (stationNodes[name] || []).map((idx) => (edges[idx] ? edges[idx].length : 0));
    stats.textContent = `${name}`

    const field = computeField(timesForDisplay);
    latestContours = buildContours(field.values);
    prepareLevelFills(field.values, name);
    prepareStationTimes(timesForDisplay);
    animateExpansion(latestContours);
  }

  function fillDatalist() {
    datalist.innerHTML = "";
    stationNames.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      datalist.appendChild(option);
    });
  }

  searchInput.addEventListener("change", () => {
    const name = searchInput.value.trim();
    if (stationByName.has(name)) selectStation(name);
  });

  randomBtn.addEventListener("click", () => {
    const name = stationNames[Math.floor(Math.random() * stationNames.length)];
    searchInput.value = name;
    selectStation(name);
  });

  labelToggle.addEventListener("change", updateLabelVisibility);

  window.addEventListener("resize", resizeCanvas);

  buildLegend();
  fillDatalist();
  image.src = DATA.meta.image;
  image.onload = () => {
    createStations();
    updateLabelVisibility();
    resizeCanvas();
  };
})();
