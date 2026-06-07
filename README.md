🌊 LAKE - TikTok Username Checker
LAKE is a high-performance, asynchronous Python tool designed to check the availability of TikTok usernames. It supports both random generation and bulk checking from a list, with integrated Discord Webhook support for real-time "hit" notifications.

🚀 Features
Asynchronous Speed: Built with aiohttp and asyncio for non-blocking network requests.

Dual Modes:

Generator: Generate and check random alphanumeric usernames of any length.

List Checker: Import a custom list of usernames via usernames.txt.

Discord Integration: Automatically sends a formatted embed to your Discord channel when an available username is found.

Smart Rate Limiting: Includes built-in delays, random User-Agents, and automated cooldowns to protect your IP from being flagged.

Auto-Save: All available usernames (hits) are automatically saved to hits.txt.

🛠️ Installation
Clone the repository (or save the script as lake.py):
git clone https://github.com/yourusername/lake.git
cd lake

Install dependencies:
You will need aiohttp and requests.
pip install aiohttp requests

⚙️ Configuration
Open the script and locate the CONFIGURATION section at the top. Replace the placeholder with your actual Discord Webhook URL:

# --- CONFIGURATION ---
WEBHOOK_URL = "YOUR_WEBHOOK_HERE"
# ---------------------

📖 How to Use
Run the script using Python:
python lake.py

Options:
Option [1]: Enter the desired character length. The script will continuously generate batches of random usernames and check them.

Option [2]: Create a file named usernames.txt in the same directory. Put one username per line. The script will iterate through the list and stop when finished.

⚠️ Important Notes
Rate Limits: TikTok has strict rate limits. If you see [RATE LIMIT] in the logs, the script will automatically pause for 60 seconds.

False Positives: The script checks for 404 status codes and specific HTML markers. Occasionally, "banned" or "shadowbanned" accounts may appear available.

Concurrency: The default max_concurrent is set to 3. Increasing this may result in faster IP bans unless you implement a proxy rotation.

📝 License
This project is for educational purposes only. Use of this tool for automated scraping or account squatting may violate TikTok's Terms of Service.

Developed by JXYV
