/**
 * schedule.js
 * Travel schedule CRUD + likes.
 * Supports both:
 * - room-integrated schema: schedules(room_id, place_name, place_x, place_y, ...)
 * - legacy standalone schema: schedules(user_id, trip_date, trip_time, content, ...)
 */

const scheduleList = document.querySelector("#schedule-list");
const addForm = document.querySelector("#add-schedule-form");
let roomId = new URLSearchParams(location.search).get("roomId");

const editForm = document.querySelector("#edit-schedule-form");
const editFormWrapper = document.querySelector("#edit-form-wrapper");
const editCancelBtn = document.querySelector("#edit-cancel-btn");
const userStatusEl = document.querySelector("#user-status");
const logoutBtn = document.querySelector("#logout-btn");

let lastSchedules = [];

function renderScheduleMarkers(list) {
  if (typeof showMarkers !== "function" || typeof mapState === "undefined" || !mapState.ready) return;

  const located = (list || [])
    .filter((schedule) => schedule.place_x && schedule.place_y)
    .map((schedule) => ({
      x: schedule.place_x,
      y: schedule.place_y,
      place_name: schedule.place_name,
    }));

  showMarkers(located);
}

supabaseClient.auth.onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_OUT") {
    try {
      const raw = localStorage.getItem("sb-session");
      if (raw && JSON.parse(raw)?.user?.id) return;
    } catch {}
  }

  if (session) {
    userStatusEl.textContent = `${session.user.email} 로 로그인됨`;
    logoutBtn.classList.remove("d-none");
  } else {
    userStatusEl.textContent = "로그인되지 않은 상태입니다.";
    logoutBtn.classList.add("d-none");
  }

  await renderSchedules();
});

logoutBtn.addEventListener("click", logoutHandler);

async function logoutHandler() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) return showToast(error.message, "danger");
  showToast(MSG.auth.logoutSuccess, "success");
}

async function renderSchedules() {
  const { data: { user } } = await supabaseClient.auth.getUser();

  let query = supabaseClient
    .from("schedules")
    .select("*")
    .order("trip_date", { ascending: true })
    .order("trip_time", { ascending: true });

  if (hasRoomContext()) {
    query = query.eq("room_id", roomId);
  }

  const { data: schedules, error } = await query;

  lastSchedules = schedules || [];
  renderScheduleMarkers(lastSchedules);

  scheduleList.innerHTML = "";
  if (error || !lastSchedules.length) {
    scheduleList.innerHTML = `<p class="text-center text-muted py-4">${MSG.schedule.noData}</p>`;
    return;
  }

  for (const schedule of lastSchedules) {
    const card = await buildScheduleCard(schedule, user);
    scheduleList.appendChild(card);
  }
}

async function buildScheduleCard(schedule, user) {
  const { count: likeCount } = await supabaseClient
    .from("schedule_likes")
    .select("id", { count: "exact", head: true })
    .eq("schedule_id", schedule.id);

  let isLiked = false;
  if (user) {
    const { data: likeRow } = await supabaseClient
      .from("schedule_likes")
      .select("id")
      .eq("schedule_id", schedule.id)
      .eq("user_id", user.id)
      .maybeSingle();
    isLiked = !!likeRow;
  }

  const card = document.createElement("div");
  card.className = "card mb-3 shadow-sm schedule-card";
  card.dataset.id = schedule.id;

  const dateStr = schedule.trip_date ?? "-";
  const timeStr = schedule.trip_time ? schedule.trip_time.slice(0, 5) : "-";

  card.innerHTML = `
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
        <div>
          <span class="badge bg-primary me-1 schedule-date">${dateStr}</span>
          <span class="badge bg-secondary schedule-time">${timeStr}</span>
        </div>
        <button
          class="btn btn-sm like-btn ${isLiked ? "btn-danger" : "btn-outline-danger"}"
          data-id="${schedule.id}"
          data-liked="${isLiked}"
          ${!user ? 'disabled title="로그인 후 이용 가능"' : ""}
          aria-label="좋아요 버튼"
        >
          ♥ <span class="like-count">${likeCount ?? 0}</span>
        </button>
      </div>
      ${schedule.place_name ? `<p class="card-text small mt-2 mb-0 schedule-place text-primary">📍 ${escapeHtml(schedule.place_name)}</p>` : ""}
      <p class="card-text mt-2 mb-1 schedule-content">${escapeHtml(schedule.content)}</p>
      ${user && user.id === schedule.user_id ? `
        <div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-outline-primary edit-btn" data-id="${schedule.id}">수정</button>
          <button class="btn btn-sm btn-outline-danger delete-btn" data-id="${schedule.id}">삭제</button>
        </div>
      ` : ""}
    </div>
  `;

  const likeBtn = card.querySelector(".like-btn");
  if (likeBtn && !likeBtn.disabled) {
    likeBtn.addEventListener("click", () => likeHandler(schedule.id, isLiked));
  }

  const editBtn = card.querySelector(".edit-btn");
  if (editBtn) editBtn.addEventListener("click", () => openEditForm(schedule));

  const deleteBtn = card.querySelector(".delete-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteHandler(schedule.id));

  return card;
}

addForm.addEventListener("submit", addHandler);

async function addHandler(event) {
  event.preventDefault();

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return showToast(MSG.auth.notLoggedIn, "warning");

  const formData = new FormData(event.target);
  const trip_date = formData.get("trip_date");
  const trip_time = formData.get("trip_time");
  const content = formData.get("content");
  const place_name = formData.get("place_name")?.trim() || null;
  const place_x = formData.get("place_x") || null;
  const place_y = formData.get("place_y") || null;

  if (!trip_date || !trip_time || !content?.trim()) {
    return showToast(MSG.schedule.inputRequired, "warning");
  }

  const payload = buildSchedulePayload({
    trip_date,
    trip_time,
    content: content.trim(),
    user_id: user.id,
    place_name,
    place_x,
    place_y,
  });

  const { error } = await insertSchedule(payload);
  if (error) {
    console.error("schedule insert failed:", error);
    return showToast(MSG.schedule.addFail, "danger");
  }

  showToast(MSG.schedule.addSuccess, "success");
  event.target.reset();
  await renderSchedules();
}

function openEditForm(schedule) {
  editForm.querySelector("[name='edit-id']").value = schedule.id;
  editForm.querySelector("[name='edit-date']").value = schedule.trip_date;
  editForm.querySelector("[name='edit-time']").value = schedule.trip_time?.slice(0, 5) ?? "";
  editForm.querySelector("[name='edit-content']").value = schedule.content;

  editFormWrapper.classList.remove("d-none");
  editFormWrapper.scrollIntoView({ behavior: "smooth", block: "center" });
}

editCancelBtn.addEventListener("click", closeEditForm);

function closeEditForm() {
  editFormWrapper.classList.add("d-none");
  editForm.reset();
}

editForm.addEventListener("submit", editHandler);

async function editHandler(event) {
  event.preventDefault();

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return showToast(MSG.auth.notLoggedIn, "warning");

  const formData = new FormData(event.target);
  const id = formData.get("edit-id");
  const trip_date = formData.get("edit-date");
  const trip_time = formData.get("edit-time");
  const content = formData.get("edit-content");

  if (!trip_date || !trip_time || !content?.trim()) {
    return showToast(MSG.schedule.inputRequired, "warning");
  }

  let query = supabaseClient
    .from("schedules")
    .update({ trip_date, trip_time, content: content.trim() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (hasRoomContext()) {
    query = query.eq("room_id", roomId);
  }

  const { error } = await query;
  if (error) return showToast(MSG.schedule.editFail, "danger");

  showToast(MSG.schedule.editSuccess, "success");
  closeEditForm();
  await renderSchedules();
}

async function deleteHandler(scheduleId) {
  if (!confirm(MSG.schedule.deleteConfirm)) return;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return showToast(MSG.auth.notLoggedIn, "warning");

  let query = supabaseClient
    .from("schedules")
    .delete()
    .eq("id", scheduleId)
    .eq("user_id", user.id);

  if (hasRoomContext()) {
    query = query.eq("room_id", roomId);
  }

  const { error } = await query;
  if (error) return showToast(MSG.schedule.deleteFail, "danger");

  showToast(MSG.schedule.deleteSuccess, "success");
  await renderSchedules();
}

async function likeHandler(scheduleId, isLiked) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return showToast(MSG.auth.notLoggedIn, "warning");

  if (isLiked) {
    const { error } = await supabaseClient
      .from("schedule_likes")
      .delete()
      .eq("schedule_id", scheduleId)
      .eq("user_id", user.id);
    if (error) return showToast(MSG.like.fail, "danger");
  } else {
    const { error } = await supabaseClient
      .from("schedule_likes")
      .insert({ schedule_id: scheduleId, user_id: user.id });
    if (error) return showToast(MSG.like.fail, "danger");
  }

  await renderSchedules();
}

function hasRoomContext() {
  return isUuid(roomId);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function buildSchedulePayload({ trip_date, trip_time, content, user_id, place_name, place_x, place_y }) {
  const payload = { trip_date, trip_time, content, user_id };

  if (hasRoomContext()) {
    payload.room_id = roomId;
  }
  if (place_name) {
    payload.place_name = place_name;
  }
  if (place_x) {
    payload.place_x = place_x;
  }
  if (place_y) {
    payload.place_y = place_y;
  }

  return payload;
}

async function insertSchedule(payload) {
  let result = await supabaseClient
    .from("schedules")
    .insert(payload)
    .select()
    .single();

  if (!result.error) return result;
  if (!shouldRetryScheduleInsert(result.error)) return result;

  const fallbackPayload = {
    trip_date: payload.trip_date,
    trip_time: payload.trip_time,
    content: payload.content,
    user_id: payload.user_id,
  };

  return supabaseClient
    .from("schedules")
    .insert(fallbackPayload)
    .select()
    .single();
}

function shouldRetryScheduleInsert(error) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    text.includes("room_id") ||
    text.includes("place_name") ||
    text.includes("place_x") ||
    text.includes("place_y") ||
    text.includes("schema cache") ||
    text.includes("column")
  );
}

function showToast(message, type = "info") {
  let container = document.querySelector("#toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container position-fixed bottom-0 end-0 p-3";
    container.style.zIndex = 1100;
    document.body.appendChild(container);
  }

  const toastEl = document.createElement("div");
  toastEl.className = `toast align-items-center text-bg-${type} border-0`;
  toastEl.setAttribute("role", "alert");
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(toastEl);

  const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
  toast.show();
  toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
