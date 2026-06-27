# import schedule
# import time
# import requests
# import logging
# from datetime import datetime

# # Set up basic logging
# logging.basicConfig(
#     level=logging.INFO,
#     format='[%(asctime)s] %(levelname)s - %(message)s',
#     datefmt='%Y-%m-%d %H:%M:%S'
# )

# # Configuration
# # Pointing to a standard OpenAI-compatible completions endpoint
# API_ENDPOINT = "http://localhost:8000/v1/chat/completions"
# TARGET_TIME = "14:56"  # 24-hour format (e.g., 3:00 PM)

# def execute_codex_task():
#     """The function that actually sends the message/payload."""
#     logging.info("Executing scheduled Codex task...")
    
#     payload = {
#         "model": "default-model",
#         "messages": [
#             {"role": "system", "content": "You are a helpful assistant."},
#             {"role": "user", "content": "Automated system check flag execution."}
#         ],
#         "temperature": 0.7
#     }
    
#     headers = {
#         "Content-Type": "application/json",
#         # "Authorization": "Bearer YOUR_API_KEY" # Uncomment if needed
#     }
    
#     try:
#         response = requests.post(API_ENDPOINT, json=payload, headers=headers, timeout=10)
#         response.raise_for_status()  # Raise an exception for bad status codes
        
#         data = response.json()
#         logging.info(f"Success! Response received: {data['choices'][0]['message']['content'][:50]}...")
        
#     except requests.exceptions.RequestException as e:
#         logging.error(f"Failed to execute target endpoint: {e}")

# # ---------------------------------------------------------
# # SCHEDULER SETUP
# # ---------------------------------------------------------
# # Schedule the task every day at the specific time
# schedule.every().day.at(TARGET_TIME).do(execute_codex_task)

# logging.info(f"Automation script started. Waiting to trigger daily at {TARGET_TIME}...")

# # Keep the script running
# try:
#     while True:
#         schedule.run_pending()
#         # Sleep to prevent the while loop from maxing out your CPU
#         time.sleep(1)
# except KeyboardInterrupt:
#     logging.info("Automation script manually stopped.")

import schedule
import time
import subprocess
import urllib.parse
import logging

# Basic console logging setup
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')

# Configuration
TARGET_TIME = "15:00"  # 24-hour format
TASK_PROMPT = "Hi, please execute the scheduled tasks."

def trigger_vscode_agent():
    logging.info("Time reached! Triggering VS Code extension task...")
    
    # 1. URL-encode the message so it passes safely through the command line
    encoded_prompt = urllib.parse.quote(TASK_PROMPT)
    
    # 2. Construct the VS Code deep link URI. 
    # If you are using Roo Code, its identifier is 'RooVeterinaryInc.roo-cline'.
    # If you are using Cline, replace it with 'saoudrizwan.claude-dev'.
    # If you built your own extension, use 'your-publisher.your-extension-name'
    vscode_uri = f"vscode://RooVeterinaryInc.roo-cline/new-task?prompt={encoded_prompt}"
    
    try:
        # 3. Use the VS Code CLI to dispatch the URI natively
        # This will open VS Code (if closed) or focus the window, and inject the prompt
        subprocess.run(["code", "--open-url", vscode_uri], check=True)
        logging.info("Successfully pushed task to VS Code.")
        
    except FileNotFoundError:
        logging.error("VS Code CLI not found. Make sure 'code' is added to your system PATH.")
    except Exception as e:
        logging.error(f"Error launching task: {e}")

# Schedule the daily trigger
schedule.every().day.at(TARGET_TIME).do(trigger_vscode_agent)

logging.info(f"Python scheduler running. Waiting to send the message at {TARGET_TIME}...")

try:
    while True:
        schedule.run_pending()
        time.sleep(1) # Sleep to conserve CPU
except KeyboardInterrupt:
    logging.info("Scheduler stopped manually.")