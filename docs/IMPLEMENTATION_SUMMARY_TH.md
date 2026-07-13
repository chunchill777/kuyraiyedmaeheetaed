# สรุปการปรับปรุงระบบ ScrapeAI

อัปเดตล่าสุด: 13 กรกฎาคม 2026

## สถานะ

งานปรับปรุงระบบ scraping ภายใน repository นี้เสร็จแล้ว โดยระบบรองรับการเพิ่ม
source ใหม่ การประมวลผลตามลำดับ FIFO การ scrape ย้อนหลัง 365 วัน และการคัดกรอง
ข้อมูลก่อนบันทึกลงฐานข้อมูล

สิ่งที่ยังไม่ได้ทำเป็นงานภายนอก repository ได้แก่ การ commit/push, การเชื่อมกับ
backend repository และการทดสอบแบบ canary ด้วย source จริงหนึ่งตัว

## สิ่งที่ดำเนินการแล้ว

### 1. Source queue แบบ FIFO

- Source ใหม่ทุกตัวถูกสร้างเป็น source job
- Worker เลือก job ที่เก่าที่สุดก่อนเสมอ
- ประมวลผลทีละ source และไม่เริ่ม source ถัดไปก่อน job ปัจจุบันจบ
- รองรับ heartbeat, stale-job recovery และจำกัดจำนวนครั้งที่ retry
- บังคับให้ source job ใหม่ scrape ย้อนหลัง exactly 365 วัน
- URL เดียวกันสามารถเป็นงานของหลาย source jobs ได้ โดยแยกสถานะผ่าน
  `source_job_urls`

ไฟล์หลัก:

- `src/sourceQueue.ts`
- `src/processSourceQueue.ts`
- `src/addSource.ts`
- `src/sourceQueueStatus.ts`

### 2. ล้าง queue เดิม

- เปลี่ยน legacy pending URLs จำนวน 6,914 รายการเป็น `skipped`
- ลบ Crawlee request queue เดิมประมาณ 8 GB
- ไม่ลบบทความที่ scrape ไว้ก่อนหน้า
- สร้างฐานข้อมูลสำรองก่อนดำเนินการที่
  `data/crawler-before-fifo-20260713.db`
- Crawlee queue ใหม่เป็นแบบ in-memory ส่วนสถานะงานที่ต้องคงอยู่เก็บใน SQLite

สถานะฐานข้อมูลหลังดำเนินการ:

| รายการ | จำนวน |
| --- | ---: |
| URLs: crawled | 52,963 |
| URLs: failed เดิม | 3,404 |
| URLs: skipped | 113,387 |
| URLs: pending | 0 |
| Articles ที่เก็บไว้ | 52,145 |
| Source jobs ใหม่ใน queue | 0 |

URLs สถานะ `failed` ข้างต้นเป็นข้อมูล legacy ใน catalog และไม่ได้อยู่ใน source
queue ใหม่

### 3. Discovery และ sitemap safety

- รองรับ sitemap URL set และ sitemap index
- รองรับ namespace, XML entities, `lastmod`, gzip sitemap, archive templates,
  search templates และ bounded pagination
- ไม่ส่งหน้า archive, listing หรือ pagination เข้า article queue
- ถ้า sitemap/listing ล้มเหลวหรือชน safety cap ระบบจะ fail job แทนการยอมรับ
  backfill ที่ไม่ครบ
- จำกัดจำนวน article URLs, จำนวน sitemap files, sitemap depth, ขนาด download และ
  ขนาดหลัง decompress
- ตรวจ protocol, credentials, hostname, DNS และ private/non-public IP ranges
- ตรวจ final domain, HTTP status, content type และ response address

ไฟล์หลัก:

- `src/discover.ts`
- `src/urlSafety.ts`
- `src/crawlerConfiguration.ts`

หมายเหตุ: production ควรมี outbound firewall เพิ่มเติม เพราะ application-level
DNS validation ไม่สามารถกำจัด DNS-rebinding ระหว่าง resolver กับ browser socket
ได้อย่างสมบูรณ์

### 4. Article extraction และ data cleaning

- ใช้ Mozilla Readability ในการแยกเนื้อหาหลัก
- เอา whole-body fallback เดิมออก
- ลบ navigation, footer, form, script, style, iframe, related content และองค์ประกอบ
  รบกวนก่อนตรวจคุณภาพ
- ต้องมี Article JSON-LD หรือ `og:type=article`
- รับวันเผยแพร่จาก publication metadata หรือ JSON-LD `datePublished` ที่กำหนดไว้
- ไม่ใช้ `dateModified`, `dateCreated` หรือ `<time>` ทั่วไปเป็นวันเผยแพร่
- ปฏิเสธวันที่หาย ผิดรูปแบบ ไม่มี timezone เก่าเกิน 365 วัน หรืออยู่ในอนาคต
- ปฏิเสธ title แบบ archive/error/generic
- ปฏิเสธ HTML shell, JavaScript, CSS, cookie/consent screen, paywall, bot challenge,
  navigation-heavy content, เนื้อหาสั้นเกินไป และข้อความซ้ำผิดปกติ
- เก็บ rejected page พร้อม reason code แทนการบันทึกลง `articles`
- canonicalize URL และลบ tracking parameters
- deduplicate ด้วย canonical URL และ normalized exact-content hash

ไฟล์หลัก:

- `src/crawlArticles.ts`
- `src/articleQuality.ts`
- `src/db.ts`

### 5. Database protection

- ใช้ additive SQLite migrations และเปิด foreign-key enforcement
- เพิ่ม `sources`, `source_jobs`, `source_job_urls` และ `rejected_pages`
- เพิ่ม source/job ownership, canonical URL, cleaned timestamp และ quality score ให้
  articles
- Database triggers ป้องกัน job-owned articles ที่:
  - ไม่มี canonical URL
  - ไม่มีวันเผยแพร่หรือวันที่ผิดรูปแบบ
  - อยู่นอก rolling 365-day window
  - เนื้อหาสั้นกว่าเกณฑ์
  - ไม่มี quality score หรือคะแนนต่ำกว่าเกณฑ์
  - ซ้ำกับ canonical URL หรือ content hash ที่มีอยู่
- ใช้ guard เดียวกันกับ legacy article upgrade และ rollback เมื่อ upgrade ไม่ผ่าน

### 6. Completion gate

Source job จะ completed ได้เมื่อผ่านทุกเงื่อนไขต่อไปนี้:

- ไม่มี URL สถานะ `pending` หรือ `failed`
- มี accepted articles อย่างน้อย 10 รายการ
- acceptance rate อย่างน้อย 5%
- accepted articles ครอบคลุมอย่างน้อย 12 เดือนโดยค่าเริ่มต้น
- coverage นับเฉพาะ articles ที่ link กับ job และ URL มีสถานะ `crawled`
- rejected pages ไม่สามารถนำมาช่วยเติม coverage month
- accepted articles ไม่มีวันที่ unknown, malformed, เก่าเกิน หรือเป็นอนาคต

Source ที่มีการเผยแพร่จริงไม่ถึง 12 เดือนสามารถกำหนด `minCoverageMonths` ใน source
configuration ได้ แต่ต้องอยู่ระหว่าง 1 ถึง 13

## ผลการตรวจสอบ

- Automated tests: 35/35 ผ่าน
- TypeScript typecheck: ผ่าน
- Production build: ผ่าน
- `npm audit --omit=dev`: พบ 0 vulnerabilities
- SQLite `PRAGMA quick_check`: `ok`
- SQLite foreign-key violations: 0
- Schema version: 5
- Worker แบบ `WORKER_ONCE=true`: เปิดระบบและยืนยันว่า queue ว่างได้สำเร็จ

## คำสั่งใช้งาน

```sh
# ตรวจ source configuration และเพิ่มเข้า FIFO queue
npm run source:add -- ./source.json

# เปิด resident worker เพื่อประมวลผล source ตามลำดับ
npm run source:work

# ดูสถานะ queue
npm run source:status

# ตรวจโค้ดและทดสอบ
npm run typecheck
npm test
npm run build
```

ตัวอย่าง source configuration:

```json
{
  "name": "Example News",
  "category": "Energy",
  "baseUrl": "https://example.com",
  "sitemapUrls": ["https://example.com/sitemap.xml"],
  "minCoverageMonths": 12
}
```

## Backend integration contract

Backend ควรเรียกใช้จุดเชื่อมต่อดังนี้:

- `enqueueSource()` สำหรับเพิ่ม source
- `getSourceJob()` และ `getSourceQueueStats()` สำหรับอ่านสถานะ
- `runSourceQueue()` สำหรับ worker process
- อ่าน completion/rejection statistics จาก SQLite เพื่อแสดงผลหรือแจ้งเตือน

Endpoint ที่รับ source URL ควรต้องผ่าน authentication และ validation ฝั่ง backend
ก่อนเรียก `enqueueSource()`

## ขั้นตอนที่เหลือก่อน production

1. เพิ่ม source จริงหนึ่งตัวและทำ canary scrape ย้อนหลัง 365 วัน
2. ตรวจตัวอย่าง accepted/rejected records จาก source จริง
3. เชื่อม queue contract เข้ากับ authenticated backend API
4. Commit การเปลี่ยนแปลง ตรวจ diff แล้วจึง push/merge

ขั้นตอนเหล่านี้ไม่ใช่ช่องว่างของ implementation ภายใน repository แต่เป็นขั้นตอน
integration และ deployment ที่ต้องมี source/backend เป้าหมายจริง
