# PS-3 SpringBreak2026

Node + Express app that uses the latest `@openai/agents` SDK to plan a Spring Break trip for any destination city.

The app:

- Collects user inputs for trip timing, length, departure city, destination, activities, weather preferences, air travel class (`economy` or `business`), and hotel class (`3`, `4`, `5` stars)
- Uses multiple agents and tools (including OpenAI Web Search) to generate options for:
  - Air travel
  - Hotel
  - Car rental
  - Activities
  - Safety concerns and packing list
- Shows estimated costs in USD
- Computes destination days/nights from start/end dates and flight schedule timing (including overnight flights)
- Aligns hotel nights and car rental days/costs to computed destination stay
- Streams a live agent activity timeline so users can follow:
  - prompts sent to each agent
  - responses returned by each agent
  - tool calls (including arguments) and tool outputs
  - stage-level summaries
- Asks the user to confirm each component
- Presents a final itinerary for final confirmation
- Never purchases anything

## Agent Design

- `TripResearchAgent`: Finds realistic flight/hotel/car/activity options and pricing
- `SafetyPackingAgent`: Produces safety notes, local transport advice, and packing items
- `ItineraryComposerAgent`: Builds a structured itinerary with confirmation questions
- `FinalReviewAgent`: Produces final summary + final confirmation prompt

## Tools Used by Agents

- OpenAI hosted Web Search tool (`webSearchTool()`)
- Custom `budget_calculator` function tool for itemized USD calculations
- Standardized tool monitoring for both hosted (built-in) and custom tools via:
  - `tool_call_started`
  - `tool_call_completed`
  - derived web search events: `web_search_called`, `web_search_output`

## Project Structure

- `server.js`: Express server + API routes + in-memory itinerary state
- `src/agents/tripPlanner.js`: Agent setup, tools, orchestration, validation
- `public/index.html`: Input form + itinerary UI
- `public/app.js`: Frontend logic for planning and confirmations
- `public/styles.css`: Minimal styling

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment variables:
   Put the secret key in the Github Secrets. The code should pick up the Secret
   However, if you want to run on your own machine then you cand do the following.

   ```bash
   cp .env.example .env
   ```
  Edit `.env` and set your API key:

   ```
   OPENAI_API_KEY=...
   OPENAI_MODEL=gpt-4.1-mini
   PORT=3000
   ```

## Run

Development mode:

```bash
npm run dev
```

Production mode:

```bash
npm start
```

Open:

- `http://localhost:3000`

## API Endpoints

- `POST /api/plan`
  - Builds itinerary draft from user trip preferences
- `POST /api/plan-stream`
  - Streams planning activity events (`research`, `safety`, `composition`) and final itinerary result
- `POST /api/confirm-component`
  - Confirms one component (`flight`, `hotel`, `carRental`) by selected option ID
- `POST /api/final-confirmation`
  - Final yes/no itinerary approval
- `GET /api/health`
  - Health check

## Example Test Destinations

Use the UI and test trips to cities like:

- Paris
- Milan
- Madrid
- Taipei
- Hong Kong
- London

## Important Constraint

This application is planning-only. It never purchases flights, hotels, rentals, or activities.
