# YouTube Video/Short Analyzer (Gemini AI Powered)

An advanced web application that analyzes video files or Shorts using the Gemini API. It provides a rating/feedback on the video content, estimates the views potential, generates SEO-optimized Title, Description, and Hashtags, and outlines the correct uploading steps.

## Features
- **Video Analysis**: Upload MP4/WebM videos to evaluate pacing, visual interest, hook quality, and overall audio/video presentation.
- **AI Optimization**: Generates click-worthy, viral YouTube Titles, descriptions, and hashtags tailored to the actual visual content.
- **Upload Guide**: Detailed step-by-step instructions for uploading the specific video.
- **Premium UI**: Modern dark mode with glowing glassmorphism dashboard styling.

## Prerequisites
- Node.js installed on your machine.
- A Gemini API Key from Google AI Studio.

## Setup Instructions

1.  **Clone or Copy** the files into a directory.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create a `.env` file in the root directory:
    ```env
    GEMINI_API_KEY=your_actual_gemini_api_key_here
    PORT=3000
    ```
4.  Start the application:
    ```bash
    npm start
    ```
5.  Open [http://localhost:3000](http://localhost:3000) in your web browser.
