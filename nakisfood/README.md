# NakisPanel (Railway)

Node.js + PostgreSQL + kalıcı volume (resimler ve afişler).
Adres: https://portal.nakisfood.de

## Yapı
- `server.js` – sunucu: giriş, veri API'si (PostgreSQL), dosyalar (volume)
- `public/index.html` – NakisPanel programı
- `public/shim.js` – programı bu sunucuya bağlayan köprü
- `views/` – giriş ve veri aktarım sayfaları

## Veriler nerede?
- Tüm program verileri → PostgreSQL (`docs` tablosu)
- Ürün resimleri → volume `/data/img`
- Afişler / PDF kataloglar → volume `/data/assets`

## Railway değişkenleri (Variables)
| Değişken | Değer |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SESSION_SECRET` | en az 32 karakter rastgele metin |
| `ADMIN_PASSWORD` | acil durum admin şifresi |
| `NODE_ENV` | `production` |

`RAILWAY_VOLUME_MOUNT_PATH` volume eklenince Railway tarafından otomatik verilir.

## İlk kurulum sonrası veri aktarımı
1. Claude'daki NakisPanel → Diğer → **Tam Yedek (Railway)** → dosya iner.
2. https://portal.nakisfood.de/login → `admin` + `ADMIN_PASSWORD`.
3. https://portal.nakisfood.de/import → dosyayı seç → Aktar.
