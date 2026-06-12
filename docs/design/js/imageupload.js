document.addEventListener("DOMContentLoaded", initAlbum);

let albumCurrentUser = null;

async function initAlbum() {
  const uploadForm = document.querySelector("#upload-form");
  const imageListContainer = document.querySelector("#image-list");

  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    albumCurrentUser = user;
  } catch {
    albumCurrentUser = null;
  }

  uploadForm?.addEventListener("submit", handleUpload);
  await renderImageList(imageListContainer);
}

async function handleUpload(event) {
  event.preventDefault();

  const fileInput = event.target.querySelector("#image-file");
  const file = fileInput.files[0];
  if (!file) {
    showToast("업로드할 이미지를 선택해 주세요.");
    return;
  }

  const session = readSBSession();
  if (!session?.access_token) {
    showToast("로그인이 필요합니다.");
    return;
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  albumCurrentUser = user;
  if (!user?.id) {
    showToast("로그인이 필요합니다.");
    return;
  }

  const ext = file.name.split(".").pop();
  const roomKey = resolveAlbumRoomKey();
  const storagePath = buildImagePath(roomKey, user.id, ext);

  try {
    const uploadRes = await fetch(
      `https://porvghadkgpamnvbuyqu.supabase.co/storage/v1/object/image/${storagePath}`,
      {
        method: "POST",
        headers: {
          apikey: "sb_publishable_cpvF4f7QZzxK16Q_-JNM5A_czghLSxK",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: file,
      },
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error("image upload failed:", uploadRes.status, errText);
      showToast("이미지 업로드에 실패했습니다.");
      return;
    }

    await saveImageMetadata({
      room_id: isUuid(roomId) ? roomId : null,
      storage_path: storagePath,
      original_name: file.name,
      user_id: user.id,
    });

    showToast("사진이 업로드되었습니다.");
    event.target.reset();
    await renderImageList(document.querySelector("#image-list"));
  } catch (error) {
    console.error("image upload exception:", error);
    showToast("이미지 업로드에 실패했습니다.");
  }
}

async function renderImageList(container) {
  if (!container) return;
  await renderFromSupabase(container);
}

async function renderFromSupabase(container) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    albumCurrentUser = user;

    const images = await loadAlbumEntries();
    if (!images.length) {
      container.innerHTML = "<p class='text-center text-muted py-4'>업로드된 이미지가 없습니다.</p>";
      return;
    }

    container.innerHTML = "";
    await Promise.all(images.map((image) => appendImageCard(container, image)));
  } catch (error) {
    console.error(error);
    container.innerHTML = "<p class='text-center text-muted py-4'>이미지를 불러오지 못했습니다.</p>";
  }
}

async function appendImageCard(container, image) {
  const colDiv = document.createElement("div");
  colDiv.className = "col-6 col-md-4";

  const canDelete = Boolean(albumCurrentUser?.id && image.user_id === albumCurrentUser.id);
  const imageUrl = await getSignedImageUrl(image.storage_path);
  const displayName = image.original_name || displayImageName(image.storage_path);

  colDiv.innerHTML = `
    <div class="card album-card h-100">
      <img src="${imageUrl}" class="album-img" alt="${displayName}" loading="lazy"
           onerror="this.alt='이미지를 불러올 수 없습니다';this.style.filter='grayscale(1)';">
      <div class="card-body p-2 text-center">
        <small class="text-muted text-truncate d-block">${escapeHtml(displayName)}</small>
        ${canDelete ? `<button class="btn btn-sm btn-outline-danger mt-1 image-delete">삭제</button>` : ""}
      </div>
    </div>
  `;

  const deleteButton = colDiv.querySelector(".image-delete");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => handleImageDelete(image, colDiv));
  }

  container.append(colDiv);
}

async function handleImageDelete(image, colDiv) {
  if (!albumCurrentUser?.id) {
    showToast("로그인이 필요합니다.");
    return;
  }
  if (image.user_id !== albumCurrentUser.id) {
    showToast("본인이 업로드한 이미지만 삭제할 수 있습니다.");
    return;
  }
  if (!confirm("이 이미지를 삭제하시겠습니까?")) return;

  try {
    const { error: removeError } = await supabaseClient.storage.from("image").remove([image.storage_path]);
    if (removeError) throw removeError;

    if (image.id) {
      const { error: metaDeleteError } = await supabaseClient
        .from("album_images")
        .delete()
        .eq("id", image.id)
        .eq("user_id", albumCurrentUser.id);
      if (metaDeleteError && !isMissingAlbumImagesTable(metaDeleteError)) {
        throw metaDeleteError;
      }
    }

    colDiv.remove();
    showToast("이미지가 삭제되었습니다.");

    const container = document.querySelector("#image-list");
    if (container && !container.children.length) {
      container.innerHTML = "<p class='text-center text-muted py-4'>업로드된 이미지가 없습니다.</p>";
    }
  } catch (error) {
    console.error(error);
    showToast("이미지 삭제에 실패했습니다.");
  }
}

async function loadAlbumEntries() {
  if (isUuid(roomId)) {
    const { data, error } = await supabaseClient
      .from("album_images")
      .select("id, room_id, storage_path, original_name, user_id, created_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false });

    if (!error) {
      return (data || []).map((row) => ({
        id: row.id,
        room_id: row.room_id,
        storage_path: row.storage_path,
        original_name: row.original_name,
        user_id: row.user_id,
      }));
    }

    if (!isMissingAlbumImagesTable(error)) {
      throw error;
    }
  }

  return loadAlbumEntriesFromStorage();
}

async function loadAlbumEntriesFromStorage() {
  const roomKey = resolveAlbumRoomKey();
  const { data, error } = await supabaseClient.storage.from("image").list(roomKey);
  if (error) throw error;

  return (data || [])
    .filter((file) => file.name !== ".emptyFolderPlaceholder")
    .map((file) => {
      const storage_path = `${roomKey}/${file.name}`;
      return {
        id: null,
        room_id: isUuid(roomId) ? roomId : null,
        storage_path,
        original_name: displayImageName(storage_path),
        user_id: extractOwnerIdFromPath(storage_path),
      };
    });
}

async function saveImageMetadata(row) {
  if (!row.room_id) return;

  const { error } = await supabaseClient.from("album_images").insert(row);
  if (error && !isMissingAlbumImagesTable(error)) {
    throw error;
  }
}

function isMissingAlbumImagesTable(error) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return text.includes("album_images") || text.includes("schema cache") || text.includes("relation");
}

function resolveAlbumRoomKey() {
  return isUuid(roomId) ? roomId : "global";
}

function buildImagePath(roomKey, userId, ext) {
  const cleanExt = String(ext || "jpg").replace(/[^a-zA-Z0-9]/g, "") || "jpg";
  return `${roomKey}/${userId}__${crypto.randomUUID()}.${cleanExt}`;
}

function extractOwnerIdFromPath(path) {
  const fileName = String(path || "").split("/").pop() || "";
  const [prefix] = fileName.split("__");
  return isUuid(prefix) ? prefix : null;
}

function displayImageName(path) {
  const fileName = String(path || "").split("/").pop() || "";
  const parts = fileName.split("__");
  return parts.length > 1 ? parts.slice(1).join("__") : fileName;
}

async function getSignedImageUrl(path) {
  const { data, error } = await supabaseClient.storage.from("image").createSignedUrl(path, 3600);
  if (error) {
    console.error(error);
    return "";
  }
  return data?.signedUrl || "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
