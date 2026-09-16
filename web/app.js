const MIN_SLOTS_PER_SEMESTER = 5;
const FIXTURE_URL = "../contracts/fixtures/courses.sample.json";

// Term semesters (not transfer) must be named exactly "Fall 2026",
// "Spring 2027", "Summer 2028", etc.
const TERM_NAME_PATTERN = /^(Fall|Spring|Summer) \d{4}$/;

const INITIAL_SEMESTERS = [
  { name: "Transfer / AP Credit", isTransfer: true },
  { name: "Fall 2026" },
  { name: "Spring 2027" },
  { name: "Fall 2027" },
  { name: "Spring 2028" },
  { name: "Fall 2028" },
  { name: "Spring 2029" },
  { name: "Fall 2029" },
  { name: "Spring 2030" },
];

// The "Normal Schedule" reference panel — a hand-placed recommended plan.
// Read-only; clicking a tile here copies the course into whatever slot is
// currently selected in Your Plan. Independent of Your Plan's semester list.
const TEMPLATE_SEMESTER_LABELS = [
  "Freshman 1", "Freshman 2",
  "Sophomore 1", "Sophomore 2",
  "Junior 1",
];
const TEMPLATE_PLAN = {
  "Freshman 1": ["CAS MA 123", "CAS PY 211", "CAS WR 120", "ENG EK 125"],
  "Freshman 2": ["CAS MA 124", "CAS PY 212", "CAS EN 101", "EE 101"],
  "Sophomore 1": ["CAS MA 225", "EE 211", "CAS SO 100"],
  "Sophomore 2": ["EE 212", "EE 302", "CAS HI 108"],
  "Junior 1": ["EE 341"],
};

let coursesByCode = new Map();

// Your Plan's semesters, in display order. Reordering drag-and-drop just
// reorders this array; slot keys are id-based so they survive reordering.
let semesters = [];
let nextSemesterId = 1;

// slotState is Your Plan only — the template panel is static and unaffected.
// Maps a slot key ("<semesterId>::<index>") to a course code or null.
const slotState = new Map();

let selectedSlotKey = null;
let activeManualSlotKey = null;
let dragState = null;

function semesterSlotKey(semesterId, index) {
  return `${semesterId}::${index}`;
}

function makeSemester(name, { isTransfer = false } = {}) {
  return {
    id: `sem-${nextSemesterId++}`,
    name,
    isTransfer,
    isGap: false,
    slotCount: MIN_SLOTS_PER_SEMESTER,
  };
}

function registerSemesterSlots(semester) {
  for (let i = 0; i < semester.slotCount; i++) {
    slotState.set(semesterSlotKey(semester.id, i), null);
  }
}

function buildInitialState() {
  INITIAL_SEMESTERS.forEach(({ name, isTransfer }) => {
    const semester = makeSemester(name, { isTransfer: !!isTransfer });
    semesters.push(semester);
    registerSemesterSlots(semester);
  });
}

function addSemester(isTransfer) {
  const semester = makeSemester(isTransfer ? "Transfer Credit" : "Fall 2026", { isTransfer });
  semesters.push(semester);
  registerSemesterSlots(semester);
  renderBoard();
  focusSemesterNameInput(semester.id);
}

function removeSemester(semesterId) {
  const semester = semesters.find((s) => s.id === semesterId);
  semesters = semesters.filter((s) => s.id !== semesterId);
  if (semester) {
    for (let i = 0; i < semester.slotCount; i++) {
      slotState.delete(semesterSlotKey(semesterId, i));
    }
  }
  if (selectedSlotKey && selectedSlotKey.startsWith(`${semesterId}::`)) {
    selectedSlotKey = null;
  }
  renderBoard();
}

function clearSemester(semesterId) {
  const semester = semesters.find((s) => s.id === semesterId);
  if (!semester) {
    return;
  }
  for (let i = 0; i < semester.slotCount; i++) {
    slotState.delete(semesterSlotKey(semesterId, i));
  }
  semester.slotCount = MIN_SLOTS_PER_SEMESTER;
  registerSemesterSlots(semester);
  if (selectedSlotKey && selectedSlotKey.startsWith(`${semesterId}::`)) {
    selectedSlotKey = null;
  }
  renderBoard();
}

function findSemesterBoxEl(semesterId) {
  return document.querySelector(`.semester-box[data-semester-id="${semesterId}"]`);
}

function reorderSemestersArray(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) {
    return false;
  }
  const fromIndex = semesters.findIndex((s) => s.id === draggedId);
  const toIndex = semesters.findIndex((s) => s.id === targetId);
  if (fromIndex === -1 || toIndex === -1) {
    return false;
  }
  const [moved] = semesters.splice(fromIndex, 1);
  semesters.splice(toIndex, 0, moved);
  return true;
}

// Live preview: while dragging over a different semester, actually reorder
// the array now and FLIP-animate every box from its old screen position to
// its new one, so the row slides over to make room instead of just jumping.
function reorderWithAnimation(draggedId, targetId) {
  const boxesBefore = document.querySelectorAll("#semester-column > .semester-box");
  const firstRects = new Map();
  boxesBefore.forEach((el) => {
    firstRects.set(el.dataset.semesterId, el.getBoundingClientRect());
  });

  if (!reorderSemestersArray(draggedId, targetId)) {
    return;
  }
  renderBoard();

  const newSourceBox = findSemesterBoxEl(draggedId);
  if (newSourceBox) {
    newSourceBox.classList.add("dragging-source");
    if (dragState) {
      dragState.sourceBox = newSourceBox;
    }
  }

  document.querySelectorAll("#semester-column > .semester-box").forEach((el) => {
    const first = firstRects.get(el.dataset.semesterId);
    if (!first) {
      return;
    }
    const deltaY = first.top - el.getBoundingClientRect().top;
    if (!deltaY) {
      return;
    }
    el.style.transition = "none";
    el.style.transform = `translateY(${deltaY}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.2s ease";
      el.style.transform = "";
    });
  });
}

// Manual pointer-based drag: a full clone of the box follows the cursor
// exactly (rather than relying on the browser's native, often-faint drag
// image), while the source box dims in place to mark where it came from.
function startSemesterDrag(event, semesterId, box) {
  event.preventDefault();

  const rect = box.getBoundingClientRect();
  const ghost = box.cloneNode(true);
  ghost.classList.add("semester-drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  const ghostNameInput = ghost.querySelector(".semester-name-input");
  if (ghostNameInput) {
    ghostNameInput.value = box.querySelector(".semester-name-input").value;
  }
  document.body.appendChild(ghost);

  box.classList.add("dragging-source");

  dragState = {
    semesterId,
    ghost,
    sourceBox: box,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    lastSwapY: event.clientY,
  };

  document.addEventListener("mousemove", onSemesterDragMove);
  document.addEventListener("mouseup", onSemesterDragEnd);
}

// The cursor must travel at least this far (in px, vertically) since the
// last swap before another one can trigger. Without it, swapping a box
// with its neighbor moves that neighbor's slot right back under the
// cursor, which would otherwise immediately queue a swap back — a flicker
// loop that happens whenever the cursor sits near a boundary.
const SWAP_COOLDOWN_DISTANCE = 30;

function onSemesterDragMove(event) {
  if (!dragState) {
    return;
  }
  const { ghost, offsetX, offsetY, sourceBox, semesterId, lastSwapY } = dragState;
  ghost.style.left = `${event.clientX - offsetX}px`;
  ghost.style.top = `${event.clientY - offsetY}px`;

  if (Math.abs(event.clientY - lastSwapY) < SWAP_COOLDOWN_DISTANCE) {
    return;
  }

  const under = document.elementFromPoint(event.clientX, event.clientY);
  const targetBox = under ? under.closest(".semester-box") : null;
  if (!targetBox || targetBox === sourceBox) {
    return;
  }
  const targetId = targetBox.dataset.semesterId;
  if (!targetId || targetId === semesterId) {
    return;
  }

  reorderWithAnimation(semesterId, targetId);
  dragState.lastSwapY = event.clientY;
}

function onSemesterDragEnd() {
  if (!dragState) {
    return;
  }
  document.removeEventListener("mousemove", onSemesterDragMove);
  document.removeEventListener("mouseup", onSemesterDragEnd);

  const { ghost, sourceBox } = dragState;
  ghost.remove();
  if (sourceBox) {
    sourceBox.classList.remove("dragging-source");
  }
  dragState = null;
  // The array is already in its final order from the live preview; this
  // just clears the dimmed state and any leftover inline transform styles.
  renderBoard();
}

function focusSemesterNameInput(semesterId) {
  const input = document.querySelector(
    `.semester-box[data-semester-id="${semesterId}"] .semester-name-input`
  );
  if (input) {
    input.focus();
    input.select();
  }
}

function handleEmptyLeftClick(slotKey) {
  if (selectedSlotKey === slotKey) {
    selectedSlotKey = null;
    openManualEntry(slotKey);
    return;
  }
  selectedSlotKey = slotKey;
  renderBoard();
}

function handleFilledTrashClick(slotKey) {
  slotState.set(slotKey, null);
  renderBoard();
}

// Placing a course fills its slot and, if that fills every slot currently
// shown for that semester, grows the row by exactly one more empty slot.
function placeCourseInSlot(slotKey, code) {
  slotState.set(slotKey, code);
  const [semesterId] = slotKey.split("::");
  const semester = semesters.find((s) => s.id === semesterId);
  if (!semester) {
    return;
  }
  const isFull = Array.from({ length: semester.slotCount }, (_, i) =>
    slotState.get(semesterSlotKey(semesterId, i))
  ).every(Boolean);
  if (isFull) {
    const newIndex = semester.slotCount;
    semester.slotCount += 1;
    slotState.set(semesterSlotKey(semesterId, newIndex), null);
  }
}

function handleTemplateTileClick(course) {
  if (!selectedSlotKey) {
    return;
  }
  placeCourseInSlot(selectedSlotKey, course.code);
  selectedSlotKey = null;
  renderBoard();
}

function isCourseScheduled(code) {
  for (const scheduledCode of slotState.values()) {
    if (scheduledCode === code) {
      return true;
    }
  }
  return false;
}

function renderEmptyTile(slotKey) {
  const tile = document.createElement("div");
  tile.className = "tile empty";
  if (slotKey === selectedSlotKey) {
    tile.classList.add("selected");
  }
  tile.textContent = "+ Add Course";
  tile.addEventListener("click", () => handleEmptyLeftClick(slotKey));
  return tile;
}

function addCodeTitleFlag(tile, course) {
  const code = document.createElement("div");
  code.className = "tile-code";
  code.textContent = course.code;
  tile.appendChild(code);

  const titleEl = document.createElement("div");
  titleEl.className = "tile-title";
  titleEl.textContent = course.title;
  tile.appendChild(titleEl);

  if (course.prereq_parse_status === "failed") {
    const flag = document.createElement("span");
    flag.className = "tile-flag";
    flag.title = "Prerequisite could not be parsed";
    flag.textContent = "⚠";
    tile.appendChild(flag);
  }
}

// Your Plan tile: not clickable itself — the trash icon is the only way
// to remove it. Not a toggle/selection target.
function renderPlanTile(course, slotKey) {
  const tile = document.createElement("div");
  tile.className = `tile filled category-${course.category || "unknown"}`;
  if (course.prereq_parse_status === "failed") {
    tile.classList.add("flagged");
  }

  addCodeTitleFlag(tile, course);

  const footerRow = document.createElement("div");
  footerRow.className = "tile-footer-row";

  const trash = document.createElement("span");
  trash.className = "tile-trash";
  trash.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="3 6 5 6 21 6"></polyline>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
    '<path d="M10 11v6"></path><path d="M14 11v6"></path>' +
    '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>' +
    "</svg>";
  trash.title = "Remove course";
  trash.addEventListener("click", (event) => {
    event.stopPropagation();
    handleFilledTrashClick(slotKey);
  });
  footerRow.appendChild(trash);

  const credits = document.createElement("span");
  credits.className = "tile-credits";
  credits.textContent = `${course.credits} cr`;
  footerRow.appendChild(credits);

  tile.appendChild(footerRow);

  return tile;
}

// Normal Schedule tile: read-only reference. Greys out once that course is
// scheduled anywhere in Your Plan, otherwise click places it in the
// selected Your Plan slot.
function renderTemplateTile(course) {
  const tile = document.createElement("div");
  tile.className = `tile filled template-tile category-${course.category || "unknown"}`;
  if (course.prereq_parse_status === "failed") {
    tile.classList.add("flagged");
  }
  if (isCourseScheduled(course.code)) {
    tile.classList.add("scheduled");
  }
  tile.title = "Click to place in the selected Your Plan slot";

  addCodeTitleFlag(tile, course);

  const footer = document.createElement("div");
  footer.className = "tile-footer";
  footer.textContent = `${course.credits} cr`;
  tile.appendChild(footer);

  tile.addEventListener("click", () => handleTemplateTileClick(course));

  return tile;
}

function renderLeftSlot(slotKey, container) {
  const code = slotState.get(slotKey);
  const course = code ? coursesByCode.get(code) : null;
  if (!course) {
    container.appendChild(renderEmptyTile(slotKey));
    return;
  }
  container.appendChild(renderPlanTile(course, slotKey));
}

function renderSemesterBox(semester) {
  const box = document.createElement("div");
  box.className = "semester-box";
  if (semester.isTransfer) {
    box.classList.add("transfer");
  }
  if (semester.isGap) {
    box.classList.add("gap");
  }
  box.dataset.semesterId = semester.id;

  const header = document.createElement("div");
  header.className = "semester-header";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  handle.addEventListener("mousedown", (event) => startSemesterDrag(event, semester.id, box));
  header.appendChild(handle);

  const nameInput = document.createElement("input");
  nameInput.className = "semester-name-input";
  nameInput.type = "text";
  nameInput.value = semester.name;
  if (!semester.isTransfer) {
    nameInput.placeholder = "Fall 2026";
    nameInput.addEventListener("input", (event) => {
      nameInput.classList.toggle("invalid", !TERM_NAME_PATTERN.test(event.target.value.trim()));
    });
    nameInput.addEventListener("blur", (event) => {
      const value = event.target.value.trim();
      if (TERM_NAME_PATTERN.test(value)) {
        semester.name = value;
      } else {
        event.target.value = semester.name;
      }
      nameInput.classList.remove("invalid");
    });
  } else {
    nameInput.addEventListener("blur", (event) => {
      semester.name = event.target.value.trim() || semester.name;
      event.target.value = semester.name;
    });
  }
  header.appendChild(nameInput);

  if (semester.isTransfer) {
    const badge = document.createElement("span");
    badge.className = "badge-transfer";
    badge.textContent = "Transfer";
    header.appendChild(badge);
  }

  const gapLabel = document.createElement("label");
  gapLabel.className = "gap-toggle";
  const gapCheckbox = document.createElement("input");
  gapCheckbox.type = "checkbox";
  gapCheckbox.checked = semester.isGap;
  gapCheckbox.addEventListener("change", (event) => {
    semester.isGap = event.target.checked;
    renderBoard();
  });
  gapLabel.appendChild(gapCheckbox);
  gapLabel.appendChild(document.createTextNode(" Gap"));
  header.appendChild(gapLabel);

  const clearBtn = document.createElement("button");
  clearBtn.className = "semester-clear";
  clearBtn.textContent = "Clear";
  clearBtn.title = "Remove all courses from this semester";
  clearBtn.addEventListener("click", () => clearSemester(semester.id));
  header.appendChild(clearBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "semester-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove semester";
  removeBtn.addEventListener("click", () => removeSemester(semester.id));
  header.appendChild(removeBtn);

  box.appendChild(header);

  if (semester.isGap) {
    const gapNote = document.createElement("div");
    gapNote.className = "gap-note";
    gapNote.textContent = "Gap semester — no courses";
    box.appendChild(gapNote);
  } else {
    const row = document.createElement("div");
    row.className = "tile-row";
    for (let i = 0; i < semester.slotCount; i++) {
      renderLeftSlot(semesterSlotKey(semester.id, i), row);
    }
    box.appendChild(row);
  }

  return box;
}

function renderTemplateBox(label) {
  const box = document.createElement("div");
  box.className = "semester-box";

  const heading = document.createElement("h3");
  heading.textContent = label;
  box.appendChild(heading);

  const row = document.createElement("div");
  row.className = "tile-row";
  const codes = TEMPLATE_PLAN[label] || [];
  codes.forEach((code) => {
    const course = coursesByCode.get(code);
    if (!course) return;
    row.appendChild(renderTemplateTile(course));
  });
  box.appendChild(row);

  return box;
}

function renderTemplateColumn() {
  const column = document.getElementById("template-column");
  column.innerHTML = "";
  TEMPLATE_SEMESTER_LABELS.forEach((label) => {
    column.appendChild(renderTemplateBox(label));
  });
}

function renderBoard() {
  const column = document.getElementById("semester-column");
  column.innerHTML = "";
  semesters.forEach((semester) => {
    column.appendChild(renderSemesterBox(semester));
  });
  renderTemplateColumn();
}

function renderError(message) {
  const column = document.getElementById("semester-column");
  const box = document.createElement("div");
  box.className = "load-error";
  box.textContent = message;
  column.appendChild(box);
}

function openManualEntry(slotKey) {
  activeManualSlotKey = slotKey;
  document.getElementById("manual-course-number").value = "";
  document.getElementById("manual-course-name").value = "";
  document.getElementById("manual-course-credits").value = "4";
  document.getElementById("manual-course-gened").value = "";
  document.getElementById("manual-entry-modal").classList.remove("hidden");
}

function closeManualEntry() {
  activeManualSlotKey = null;
  document.getElementById("manual-entry-modal").classList.add("hidden");
}

function saveManualEntry() {
  const code = document.getElementById("manual-course-number").value.trim();
  if (!code) {
    return;
  }
  const name = document.getElementById("manual-course-name").value.trim();
  const credits = Number(document.getElementById("manual-course-credits").value) || 0;
  const gened = document
    .getElementById("manual-course-gened")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const course = {
    code,
    title: name || code,
    credits,
    gened,
    category: undefined,
    prereq_parse_status: "clean",
  };

  coursesByCode.set(code, course);
  placeCourseInSlot(activeManualSlotKey, code);
  closeManualEntry();
  renderBoard();
}

async function loadCourses() {
  const response = await fetch(FIXTURE_URL);
  if (!response.ok) {
    throw new Error(`Fixture fetch failed: ${response.status}`);
  }
  return response.json();
}

async function init() {
  document.getElementById("manual-entry-save").addEventListener("click", saveManualEntry);
  document.getElementById("manual-entry-close").addEventListener("click", closeManualEntry);
  document.getElementById("add-semester-btn").addEventListener("click", () => addSemester(false));
  document.getElementById("add-transfer-btn").addEventListener("click", () => addSemester(true));

  let courses;
  try {
    courses = await loadCourses();
  } catch (err) {
    console.error(err);
    renderError(
      "Could not load course fixture. This page fetches " +
        "contracts/fixtures/courses.sample.json, which browsers block " +
        "over file:// — serve this repo with a static server (e.g. " +
        "`python -m http.server` from the repo root) and open " +
        "/web/index.html instead."
    );
    return;
  }

  coursesByCode = new Map(courses.map((c) => [c.code, c]));
  buildInitialState();
  renderBoard();
}

init();
