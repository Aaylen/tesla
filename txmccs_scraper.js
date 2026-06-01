const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const TARGET_URL = "https://txmccs.txdmv.gov/automated-vehicles/operators";
const DATA_FILE = path.join(__dirname, "data.json");

// Read previous data
let previousData = {};
if (fs.existsSync(DATA_FILE)) {
    try {
        previousData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (err) {
        console.error("Failed to read data.json:", err);
    }
}

aasync function sendEmailNotification(previous, current) {
    const username = process.env.MAIL_USERNAME;
    const password = process.env.MAIL_PASSWORD;
    const toEmail = process.env.TO_EMAIL;

    if (!username || !password || !toEmail) {
        console.log("SMTP environment variables are not fully configured. Skipping email notification.");
        return;
    }

    console.log("Sending email notification...");
    const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
            user: username,
            pass: password,
        },
    });

    // 1. Extract dates from the objects (fallback to 'N/A' if missing)
    const prevDate = previous.timestamp || "Previous Date";
    const currDate = current.timestamp || "New Date";

    // 2. Calculate differences for the header announcement
    const waymoDiff = (current.Waymo || 0) - (previous.Waymo || 0);
    const zooxDiff = (current.Zoox || 0) - (previous.Zoox || 0);
    const teslaDiff = (current.Tesla || 0) - (previous.Tesla || 0);

    // 3. Build a dynamic announcement string based on what changed
    let announcement = "";
    if (waymoDiff > 0) announcement += `Waymo added ${waymoDiff} cars!\n`;
    if (zooxDiff > 0) announcement += `Zoox added ${zooxDiff} cars!\n`;
    if (teslaDiff > 0) announcement += `Tesla added ${teslaDiff} cars!\n`;
    
    // Fallback if numbers didn't go up, but data still technically changed
    if (!announcement) announcement = "Data updated with new counts!\n";

    // 4. Construct the cleanly formatted text email
    const emailText = `${announcement}
---------------------------------------------

Old Data (${prevDate})
Waymo: ${previous.Waymo ?? 0}
Zoox: ${previous.Zoox ?? 0}
Tesla: ${previous.Tesla ?? 0}

New Data (${currDate})
Waymo: ${current.Waymo ?? 0}
Zoox: ${current.Zoox ?? 0}
Tesla: ${current.Tesla ?? 0}`;

    const mailOptions = {
        from: `"TxMCCS Scraper" <${username}>`,
        to: toEmail,
        subject: "TxMCCS Scraper: Data Changed",
        text: emailText,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Email sent successfully:", info.messageId);
    } catch (err) {
        console.error("Failed to send email:", err);
    }
}

async function getTotalCars(page, companyName) {
    // Navigate to the page
    console.log(`Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2" });

    // Select search by company name
    await page.click('[aria-label="Search Type"]');
    await page.waitForSelector('[role="option"]');
    await page.evaluate(() => {
        const options = document.querySelectorAll('[role="option"]');
        for (const opt of options) {
            if (opt.textContent.trim() === 'Company Name') {
                opt.click();
                return;
            }
        }
        throw new Error('Could not find "Company Name" option');
    });

    // Load Company Data
    await page.click('[name="searchValue"]');
    await page.type('[name="searchValue"]', companyName);
    await page.keyboard.press('Enter');
    await page.waitForSelector('tbody tr', { visible: true, timeout: 30000 });

    // Go to company details
    await page.evaluate(() => {
        const firstRow = document.querySelector('tbody tr');
        if (!firstRow) throw new Error('No table rows found');
        // Try clicking an anchor link first, then fall back to the first cell
        const link = firstRow.querySelector('a');
        if (link) { link.click(); return; }
        const clickable = firstRow.querySelector('td');
        if (clickable) { clickable.click(); return; }
        throw new Error('No clickable element in first row');
    });

    // Wait for the detail page's row count element to appear
    const totalRows = await page.waitForFunction(() => {
        const els = document.querySelectorAll('.text-muted-foreground');
        for (const el of els) {
            const match = el.textContent.match(/of\s+([\d,]+)\s+rows/i);
            if (match) return parseInt(match[1].replace(/,/g, ''), 10);
        }
        return null;
    }, { timeout: 30000 }).then(handle => handle.jsonValue());
    return totalRows;
}

async function scrape() {
    console.log("Launching browser...");
    const isGithubAction = !!process.env.GITHUB_ACTIONS;
    const browser = await puppeteer.launch({
        headless: isGithubAction ? true : false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    const TeslaTotalCars = await getTotalCars(page, "TESLA");
    const WaymoTotalCars = await getTotalCars(page, "WAYMO");
    const ZooxTotalCars = await getTotalCars(page, "ZOOX");

    const newData = {
        timestamp: new Date().toLocaleDateString(), // Generates "6/1/2026" depending on system locale
        Tesla: TeslaTotalCars,
        Waymo: WaymoTotalCars,
        Zoox: ZooxTotalCars,
    };

    console.log(JSON.stringify(newData, null, 2));

    // Check if data changed
    const hasChanged = JSON.stringify(newData) !== JSON.stringify(previousData);
    if (hasChanged) {
        console.log("Data changed! Writing to data.json...");
        fs.writeFileSync(DATA_FILE, JSON.stringify(newData, null, 2), "utf8");

        // Send Email Notification
        await sendEmailNotification(previousData, newData);

    } else {
        console.log("No changes detected.");
    }

    await browser.close();
    console.log("\nDone.");
}

scrape().catch((err) => {
    console.error("Scraper failed:", err);
    process.exit(1);
});
