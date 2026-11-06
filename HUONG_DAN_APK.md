# Tạo file APK Kế Hoạch (Android) — báo thức thật như app đồng hồ

APK này chứa sẵn toàn bộ app (chạy offline) + báo thức hệ thống: nhắc đúng giờ **kể cả khi đã đóng app, khoá màn hình, khởi động lại máy**, và đếm ngược cũng báo khi hết giờ. Vẫn đồng bộ Firebase như bản web.

## Lấy file APK (không cần cài Android Studio)
1. Tạo tài khoản https://github.com (miễn phí) → **New repository** (để Private cũng được).
2. Giải nén thư mục này, upload **toàn bộ nội dung** (kể cả thư mục ẩn `.github`) lên repo: *Add file → Upload files*. Nếu trình duyệt không cho kéo thư mục ẩn, dùng GitHub Desktop.
3. Vào tab **Actions** → *Build APK* → **Run workflow**. Đợi ~5–8 phút.
4. Bấm vào lần chạy vừa xong → mục **Artifacts** → tải `KeHoach-apk` (file zip chứa `app-debug.apk`).
5. Chép APK sang điện thoại, mở và cài (cho phép "Cài ứng dụng không rõ nguồn" nếu máy hỏi).

## Sau khi cài lần đầu
- Mở app → bấm **🔔 Chuông** → cho phép thông báo; nếu máy hỏi quyền **Báo thức & lời nhắc** thì bật. Sẽ có thông báo thử sau 2 giây.
- Một số hãng (Xiaomi, Oppo, Vivo, Realme, Samsung) hay chặn app nền: vào *Cài đặt → Ứng dụng → Kế Hoạch → Pin* chọn **Không hạn chế**, và bật **Tự khởi động** nếu có.

## Cập nhật app sau này
Sửa file trong `www/` (copy từ bản web đã deploy), commit lại → Actions tự build APK mới. Cài đè lên bản cũ, dữ liệu giữ nguyên.
