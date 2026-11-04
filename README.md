# ARON Signage v2 – Hệ thống quản lý màn hình nội bộ

Quản lý nhiều Tivi từ một trang quản trị. Mỗi Tivi được ghép nối bằng mã 6 số, có nhóm (chi nhánh/tầng/khu vực), nội dung và thông báo khẩn cấp nhắm tới từng nhóm hoặc từng màn, điều khiển từ xa, và vẫn phát được khi mất mạng.

Đây là **dự án độc lập**: dùng project Supabase và repo GitHub riêng, không ảnh hưởng tới app cũ.

| Đường dẫn | Dùng cho |
|---|---|
| `admin.html` | Trang quản trị (đăng nhập bằng email) |
| `player.html` | Mở trên Tivi (không cần đăng nhập) |
| `index.html` | Tự chuyển: Tivi đã ghép nối → player, còn lại → admin |
| `config.js` | **Điền URL + Publishable key của project Supabase** |
| `supabase/supabase_full.sql` | Tạo toàn bộ database trên project mới |
| `supabase/export_tu_app_cu.sql` | Chép dữ liệu từ app cũ sang (chỉ đọc app cũ) |
| `supabase/functions/feed/index.ts` | Edge Function đọc lịch ICS / Google Sheet |

---

## Chuyển từ app cũ sang (khoảng 20 phút)

Project cũ: `aron_signage` (ref `celqybfrjzrxvhlhtrqo`). Project mới: `Aron signage-db v2`. Trong suốt quá trình, app cũ **chỉ bị đọc**, không bị sửa gì.

### 1. Tạo database trên project MỚI
Mở **SQL Editor → New query**, dán toàn bộ `supabase/supabase_full.sql` rồi bấm **Run**.
> ⚠️ **Chưa tạo user** ở bước này. Tài khoản sẽ được chép sang từ app cũ ở bước 2.

### 2. Chép dữ liệu: project CŨ → project MỚI
1. Mở SQL Editor của **project cũ**, chạy `supabase/export_tu_app_cu.sql`.
2. Bấm vào ô kết quả `lenh_nhap` → **Copy cell**.
3. Mở SQL Editor của **project mới**, dán vào rồi bấm **Run**. Màn hình báo `✅ Đã nhập: … tài khoản, … phân quyền, … slide, … nguồn lịch/KPI.`

Những gì được chép:
- Tài khoản đăng nhập, **giữ nguyên mật khẩu cũ**.
- Phân quyền Admin / Editor / Creator; Owner vẫn là `kietdmt@aron.com.vn`.
- Mã PIN Tivi.
- Link lịch / Google Sheet bí mật.
- Cài đặt chung và toàn bộ slide.

Chạy lại lệnh nhập nhiều lần vẫn an toàn: phần nào đã có sẽ được bỏ qua.

> Nếu Supabase báo lỗi quyền khi chép tài khoản (`auth.users`), hãy tạo lại user thủ công ở **Authentication → Users → Add user** rồi chạy lại lệnh nhập. Phân quyền sẽ không tự áp dụng; Admin chọn lại quyền trong trang quản trị. Riêng user có email `kietdmt@aron.com.vn` tự thành Admin + Owner.

### 3. Cài đặt khác trên project MỚI
- **Authentication → Sign In / Providers → Email**: tắt *Confirm email* (để Admin tự tạo user cho nhân viên).
- **Edge Functions → Deploy a new function → Via Editor**:
  1. Đặt tên `feed`, dán `supabase/functions/feed/index.ts`, bấm **Deploy**.
  2. Mở **Details**, tắt **Verify JWT**, bấm **Save**.
- **Project Settings → API Keys**: copy *Project URL* và *Publishable key* rồi dán vào `config.js` (2 dòng `url`, `key`).

### 4. Đưa lên GitHub Pages
1. Tạo repo mới trên GitHub (ví dụ `aron-signage-v2`) rồi push toàn bộ thư mục này lên.
2. Vào **Settings → Pages → Build and deployment**, chọn *Deploy from a branch*, branch `main`, thư mục `/ (root)`.
3. Sau 1–2 phút có hai địa chỉ:
   - Quản trị: `https://<tài-khoản>.github.io/aron-signage-v2/admin.html`
   - Tivi: `https://<tài-khoản>.github.io/aron-signage-v2/player.html`

### 5. Chép ảnh/video trong Thư viện
1. Mở `admin.html` và đăng nhập bằng tài khoản cũ.
2. Vào tab **⚙️ Cài đặt chung**, bấm **📦 Chép thư viện từ app cũ** → **Bắt đầu chép**.

Hệ thống tải từng file từ project cũ sang project mới, rồi tự đổi link trong các slide và logo. File nào lỗi thì giữ link cũ (vẫn hiển thị); bấm lại nút để thử lại. Chép xong có thể xóa khối `old` trong `config.js`.

### 6. Ghép nối Tivi
1. Trên Tivi, mở `player.html`. Màn hình hiện mã 6 số.
2. Trên trang quản trị, bấm **➕ Ghép nối Tivi**, nhập mã, đặt tên và chọn nhóm.

Nên chạy Tivi ở chế độ kiosk:
- **Android TV box:** dùng *Fully Kiosk Browser*, bật Kiosk Mode, Launch on Boot, Keep Screen On.
- **Mini PC:** chạy `chrome --kiosk --autoplay-policy=no-user-gesture-required <link player.html>`.

---

## Phân quyền
| Việc | Admin | Editor | Creator |
|---|:-:|:-:|:-:|
| Ghép nối / sửa / gỡ Tivi, quản lý nhóm | ✅ | – | – |
| Gửi lệnh Tivi (nhận diện, chuyển slide, tải lại) | ✅ | ✅ | – |
| Tạo nội dung | ✅ | ✅ | ✅ (chờ duyệt) |
| Sửa / duyệt nội dung | ✅ | ✅ | bài chờ duyệt của mình |
| Xóa nội dung | ✅ | – | bài chờ duyệt của mình |
| Khẩn cấp, cài đặt chung, PIN, người dùng | ✅ | – | – |

Quyền được kiểm tra ở server (RLS + trigger), không thể vượt quyền bằng F12. Tivi không đọc trực tiếp bảng nào, chỉ gọi hàm RPC bằng mã bí mật riêng của từng máy.

## Kiến trúc
- Bảng: `sig_settings`, `screen_groups`, `screens`, `slides`, `alerts`, `screen_commands`, `sig_rev`, `sig_feeds`, `profiles`, `sig_secrets`, `pin_attempts`.
- Tivi gọi `screen_ping` mỗi 20 giây để nhận số phiên bản dữ liệu và lệnh từ xa. Khi có thay đổi, Tivi gọi `screen_manifest` để lấy **chỉ nội dung của màn đó**.
- Khi Admin lưu, trang quản trị gửi tín hiệu Realtime Broadcast vài byte trên kênh `aron-signage-bump`, nên Tivi cập nhật gần như tức thì. Số lượng Tivi tăng thì Egress gần như không tăng.

## Gặp lỗi?
- **Trang báo "Chưa cấu hình kết nối":** chưa điền `config.js`.
- **Trang báo "Chưa có cấu trúc dữ liệu v2":** chưa chạy `supabase_full.sql`.
- **Slide lịch/KPI báo "Không tải được":** chưa deploy Edge Function `feed`, hoặc chưa tắt *Verify JWT*.
- **Trang web nhúng hiện màn trắng:** trang đó chặn nhúng. Hãy dùng link Embed / Publish to web.
