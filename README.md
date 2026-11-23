# Bormar 2026 Replay

PWA yang menganimasikan posisi pelari Borobudur Marathon 2026 di antara seluruh peserta. User memasukkan nomor bib (cukup angkanya), lalu titiknya bersinar dan berlari di rute bersama semua pelari lain (FM, HM, 10K). Bisa membandingkan sampai 3 bib dari kategori yang sama (mode VS), masing-masing dengan warna berbeda.

Aplikasi ini sepenuhnya statis: tidak ada server, tidak ada build step. Cukup deploy folder ini ke Vercel.

## Struktur

```
index.html            halaman utama (search + replay)
css/app.css
js/sim.js             model simulasi (posisi tiap pelari pada waktu t)
js/render.js          gambar rute, crowd, dan titik bersinar di canvas
js/video.js           rekam video 9:16 di browser (MediaRecorder)
js/app.js             UI, kontrol replay, share
data/{fm,hm,10k}.json data ringkas hasil olahan (hanya bib, tanpa nama)
sw.js, manifest.webmanifest, icons/   PWA
tools/build_data.py   xlsx + GPX -> data/*.json
tools/verify_sim.mjs  cek kebenaran simulasi terhadap data
tools/ui_test.py      smoke test UI headless (opsional)
tools/gpx/            rute FM, HM, 10K
```

## Memperbarui data

File hasil (`.xlsx`) **tidak** disimpan di repo karena berisi nama peserta.

```bash
pip install openpyxl
python3 tools/build_data.py path/ke/borobudur_marathon_2026_results.xlsx
node tools/verify_sim.mjs
```

Setelah data atau file aplikasi berubah, naikkan `VERSION` di `sw.js` supaya cache PWA di HP user ikut diperbarui.

## Asumsi model

- Kolom split di file hasil adalah **waktu per segmen**, bukan kumulatif.
- Semua pelari diasumsikan start di **wave 1** (FM 04:15, HM 04:55, 10K 05:40), karena wave per pelari tidak ada di data. Posisi bisa bergeser hingga 15 menit dari aslinya.
- Di antara checkpoint, pace dianggap rata (interpolasi linear). KM resmi dipetakan proporsional ke panjang GPX.
- **FM**: kolom "KM 10" ternyata dimulai dari checkpoint tersembunyi di sekitar KM 5,6. Waktu start → KM 5,6 tidak ada di data, jadi diestimasi dan diberi tanda †.
- **Black flag 09:45 (FM saja)**: pelari tidak finish (QRY) lanjut dengan pace segmen terakhirnya sampai 09:45, lalu berhenti. Pengecualiannya: kalau diestimasi tiba di COP setelah COP itu ditutup, dia dihentikan di COP tersebut. Titik tidak pernah melewati garis finish. Finisher tetap berlari sampai finish (209 finisher memang masuk setelah 09:45). Pelari yang checkpoint terakhirnya tercatat setelah 09:45 mengikuti datanya. Alasan berhenti tersimpan di `Race.reason`.
- HM / 10K: DNF dan QRY berhenti di checkpoint terakhir yang tercatat.
- Huruf depan bib (kanal pendaftaran) dibuang; angka bib unik di ketiga kategori.
- Bib tanpa catatan checkpoint sama sekali (DNS) tidak tampil di rute.

## Link langsung

`/?bib=10404` langsung membuka replay; `/?bib=10404,10627,12600` membuka mode VS.
