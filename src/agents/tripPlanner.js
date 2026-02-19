import { Agent, run, Runner, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import {
  attachStandardToolMonitoring,
  createMonitoredHostedTool,
  tagToolForMonitoring
} from "./toolMonitoring.js";

export const TRIP_COMPONENTS = ["flight", "hotel", "carRental"];

const requestedModel = (process.env.OPENAI_MODEL || "").trim();
const model =
  !requestedModel || requestedModel === "gpt-5.3-codex"
    ? "gpt-4.1-mini"
    : requestedModel;

const tripRequestSchema = z
  .object({
    startCity: z.string().min(2),
    destinationCity: z.string().min(2),
    startDate: z.string().min(4),
    endDate: z.string().min(4),
    tripLengthDays: z.number().int().positive(),
    activities: z.array(z.string().min(2)).min(1),
    weatherPreferences: z.string().min(2),
    airTravelClass: z.enum(["economy", "business"]),
    hotelStars: z.enum(["3", "4", "5"]),
    transportationNotes: z.string().optional()
  })
  .strict()
  .refine(
    (value) => {
      const start = parseDateSafe(value.startDate);
      const end = parseDateSafe(value.endDate);
      return Boolean(start && end && end > start);
    },
    { message: "endDate must be after startDate" }
  );

const budgetCalculatorTool = tagToolForMonitoring(
  tool({
  name: "budget_calculator",
  description:
    "Calculate subtotal and total from itemized USD costs for flights, hotels, transport, and activities.",
  parameters: z.object({
    items: z.array(
      z.object({
        label: z.string(),
        costUsd: z.number().nonnegative()
      })
    )
  }),
  execute: async ({ items }) => {
    const taxRate = 0.1;
    const subtotalUsd = Number(items.reduce((sum, item) => sum + item.costUsd, 0).toFixed(2));
    const taxUsd = Number((subtotalUsd * taxRate).toFixed(2));
    const totalUsd = Number((subtotalUsd + taxUsd).toFixed(2));

    return {
      subtotalUsd,
      taxUsd,
      totalUsd,
      taxRateUsed: taxRate
    };
  }
}),
  {
    source: "custom",
    family: "budget_calculator",
    label: "budget"
  }
);

const researchWebSearchTool = createMonitoredHostedTool(() => webSearchTool(), {
  family: "web_search",
  label: "research"
});

const safetyWebSearchTool = createMonitoredHostedTool(() => webSearchTool(), {
  family: "web_search",
  label: "safety"
});

const researchAgent = new Agent({
  name: "TripResearchAgent",
  model,
  instructions: `You are a travel research specialist for MIT spring break trip planning.
Use web search for current and realistic options.
You MUST call the web search tool at least once before returning output.
You MUST return strict JSON only (no markdown, no prose outside JSON) with this schema:
{
  "flightOptions": [{"id":"f1","label":"...","airline":"...","route":"...","class":"economy|business","outboundDepartureLocal":"2026-03-21T19:00:00-04:00","outboundArrivalLocal":"2026-03-22T08:30:00+01:00","returnDepartureLocal":"2026-03-29T10:00:00+01:00","returnArrivalLocal":"2026-03-29T13:00:00-04:00","daysAtDestination":8,"nightsAtDestination":7,"costUsd":1200,"notes":"..."}],
  "hotelOptions": [{"id":"h1","label":"...","stars":4,"nightlyUsd":250,"nights":7,"costUsd":1750,"notes":"..."}],
  "carRentalOptions": [{"id":"c1","label":"...","company":"...","carType":"...","dailyRateUsd":50,"rentalDays":8,"costUsd":400,"notes":"..."}],
  "activityIdeas": [{"name":"...","estimatedCostUsd":40,"whyFit":"..."}],
  "researchNotes": ["..."],
  "pricingDateNote": "state pricing date caveat"
}
Use both user start/end dates and the flight schedule to compute daysAtDestination and nightsAtDestination.
Account for overnight flights and time zone differences.
Hotel nights and car rental days MUST align to the computed destination stay.
Return 2-3 options per component with realistic costs in USD.
Never suggest making purchases.`,
  tools: [researchWebSearchTool, budgetCalculatorTool]
});

const safetyPackingAgent = new Agent({
  name: "SafetyPackingAgent",
  model,
  instructions: `You are a safety and packing assistant.
Use web search to identify practical and current safety, local transport, and weather considerations.
You MUST call the web search tool at least once before returning output.
Return strict JSON only with schema:
{
  "safetyConcerns": ["..."],
  "packingList": ["..."],
  "localTransportAdvice": ["..."],
  "weatherSummary": "..."
}
Keep it concise and practical.`,
  tools: [safetyWebSearchTool]
});

const itineraryAgent = new Agent({
  name: "ItineraryComposerAgent",
  model,
  instructions: `You are an itinerary composer.
Given user preferences plus research and safety JSON, return strict JSON only with this schema:
{
  "tripSummary": "...",
  "stayAtDestination": {
    "arrivalLocal": "...",
    "departureLocal": "...",
    "daysAtDestination": 0,
    "nightsAtDestination": 0,
    "calculationNote": "..."
  },
  "components": {
    "flight": {"options": [], "recommendedOptionId": "f1", "confirmationQuestion": "..."},
    "hotel": {"options": [], "recommendedOptionId": "h1", "confirmationQuestion": "..."},
    "carRental": {"options": [], "recommendedOptionId": "c1", "confirmationQuestion": "..."}
  },
  "activities": [{"name":"...","estimatedCostUsd":0,"scheduledDay":"Day 1","notes":"..."}],
  "safetyConcerns": ["..."],
  "packingList": ["..."],
  "estimatedCostSummary": {
    "flightUsd": 0,
    "hotelUsd": 0,
    "carRentalUsd": 0,
    "activitiesUsd": 0,
    "totalUsd": 0
  },
  "disclaimer": "No purchases are made"
}
The three components flight/hotel/carRental must always be present.
Ask explicit confirmation questions for each component.
You MUST call the budget_calculator tool exactly once before returning output.
Use flight schedule times plus start/end dates to ensure hotel nights and car rental days match stayAtDestination.
Never recommend or perform purchasing.`,
  tools: [budgetCalculatorTool]
});

const finalReviewAgent = new Agent({
  name: "FinalReviewAgent",
  model,
  instructions: `You produce final confirmation text after the user confirms flight, hotel, and car rental.
Return strict JSON only:
{
  "finalSummary": "...",
  "finalConfirmationQuestion": "...",
  "purchaseReminder": "No purchases are made"
}`
});

export function validateTripRequest(input) {
  return tripRequestSchema.safeParse(input);
}

export async function buildItineraryDraft(preferences, options = {}) {
  const emit = typeof options.onEvent === "function" ? options.onEvent : () => {};

  emit({
    type: "planning_started",
    stage: "initialization",
    message: "Planning session started. Agents are preparing inputs."
  });

  const researchInput = [
    "Research trip options for these preferences:",
    JSON.stringify(preferences, null, 2),
    "Use web search for realistic price ranges and providers."
  ].join("\n");

  const safetyInput = [
    "Provide safety and packing recommendations for this trip:",
    JSON.stringify(preferences, null, 2)
  ].join("\n");

  emit({
    type: "agent_started",
    stage: "research",
    agent: "TripResearchAgent",
    message: "Researching flights, hotels, car rentals, and activity ideas (using web search)."
  });
  const researchResult = await runAgentWithTelemetry({
    agent: researchAgent,
    agentName: "TripResearchAgent",
    stage: "research",
    input: researchInput,
    emit
  });

  emit({
    type: "agent_started",
    stage: "safety",
    agent: "SafetyPackingAgent",
    message: "Checking safety considerations, weather, and packing guidance (using web search)."
  });
  const safetyResult = await runAgentWithTelemetry({
    agent: safetyPackingAgent,
    agentName: "SafetyPackingAgent",
    stage: "safety",
    input: safetyInput,
    emit
  });

  const researchJson = parseAgentJson(extractAgentText(researchResult), "researchAgent");
  emit({
    type: "agent_completed",
    stage: "research",
    agent: "TripResearchAgent",
    message: "Research complete.",
    summary: summarizeResearch(researchJson)
  });

  const safetyJson = parseAgentJson(extractAgentText(safetyResult), "safetyPackingAgent");
  emit({
    type: "agent_completed",
    stage: "safety",
    agent: "SafetyPackingAgent",
    message: "Safety and packing analysis complete.",
    summary: summarizeSafety(safetyJson)
  });

  const itineraryInput = [
    "Compose itinerary JSON from these trip preferences:",
    JSON.stringify(preferences, null, 2),
    "Research data:",
    JSON.stringify(researchJson, null, 2),
    "Safety/packing data:",
    JSON.stringify(safetyJson, null, 2)
  ].join("\n");

  emit({
    type: "agent_started",
    stage: "composition",
    agent: "ItineraryComposerAgent",
    message: "Composing itinerary, costs, and confirmation questions."
  });
  const itineraryResult = await runAgentWithTelemetry({
    agent: itineraryAgent,
    agentName: "ItineraryComposerAgent",
    stage: "composition",
    input: itineraryInput,
    emit
  });
  const itineraryDraft = parseAgentJson(extractAgentText(itineraryResult), "itineraryAgent");

  const normalized = normalizeItinerary(itineraryDraft, researchJson, safetyJson, preferences);
  emit({
    type: "agent_completed",
    stage: "composition",
    agent: "ItineraryComposerAgent",
    message: "Itinerary draft is ready for your review.",
    summary: summarizeItinerary(normalized)
  });

  return normalized;
}

export async function createFinalReview(preferences, itinerary, confirmations) {
  const selectedComponents = Object.fromEntries(
    TRIP_COMPONENTS.map((componentType) => {
      const confirmedOptionId = confirmations[componentType]?.optionId;
      const selectedOption =
        itinerary.components?.[componentType]?.options?.find((option) => option.id === confirmedOptionId) ?? null;
      return [componentType, selectedOption];
    })
  );

  const finalReviewInput = [
    "User has confirmed these selections:",
    JSON.stringify(selectedComponents, null, 2),
    "Trip preferences:",
    JSON.stringify(preferences, null, 2),
    "Return final confirmation prompt and reminder that nothing is purchased."
  ].join("\n");

  const reviewResult = await run(finalReviewAgent, finalReviewInput);
  return parseAgentJson(extractAgentText(reviewResult), "finalReviewAgent");
}

function normalizeItinerary(rawItinerary, researchJson, safetyJson, preferences) {
  const itinerary = structuredClone(rawItinerary ?? {});
  const computedStay = computeDestinationStay(itinerary, researchJson, preferences);

  itinerary.tripSummary = itinerary.tripSummary ?? "Trip itinerary draft";
  itinerary.components = itinerary.components ?? {};
  itinerary.stayAtDestination = itinerary.stayAtDestination ?? computedStay;

  itinerary.components.flight = normalizeComponent(
    itinerary.components.flight,
    researchJson.flightOptions,
    "Please confirm this flight option."
  );

  itinerary.components.hotel = normalizeHotelComponent(itinerary.components.hotel, researchJson.hotelOptions, computedStay);

  itinerary.components.carRental = normalizeCarComponent(
    itinerary.components.carRental,
    researchJson.carRentalOptions,
    computedStay
  );

  itinerary.activities = Array.isArray(itinerary.activities)
    ? itinerary.activities
    : (researchJson.activityIdeas ?? []).map((activity, index) => ({
        name: activity.name,
        estimatedCostUsd: activity.estimatedCostUsd ?? 0,
        scheduledDay: `Day ${index + 1}`,
        notes: activity.whyFit ?? ""
      }));

  itinerary.safetyConcerns = Array.isArray(itinerary.safetyConcerns)
    ? itinerary.safetyConcerns
    : safetyJson.safetyConcerns ?? [];

  itinerary.packingList = Array.isArray(itinerary.packingList)
    ? itinerary.packingList
    : safetyJson.packingList ?? [];

  itinerary.disclaimer = itinerary.disclaimer ?? "No purchases are made in this app.";

  itinerary.estimatedCostSummary = itinerary.estimatedCostSummary ?? estimateTotals(itinerary);

  return itinerary;
}

function normalizeComponent(component, fallbackOptions, fallbackQuestion) {
  const options = Array.isArray(component?.options) && component.options.length > 0 ? component.options : fallbackOptions ?? [];
  const firstOptionId = options[0]?.id ?? "option_1";

  return {
    options,
    recommendedOptionId: component?.recommendedOptionId ?? firstOptionId,
    confirmationQuestion: component?.confirmationQuestion ?? fallbackQuestion
  };
}

function estimateTotals(itinerary) {
  const flightUsd = optionCostById(itinerary.components.flight);
  const hotelUsd = optionCostById(itinerary.components.hotel);
  const carRentalUsd = optionCostById(itinerary.components.carRental);

  const activitiesUsd = Array.isArray(itinerary.activities)
    ? itinerary.activities.reduce((sum, activity) => sum + Number(activity.estimatedCostUsd || 0), 0)
    : 0;

  return {
    flightUsd,
    hotelUsd,
    carRentalUsd,
    activitiesUsd,
    totalUsd: Number((flightUsd + hotelUsd + carRentalUsd + activitiesUsd).toFixed(2))
  };
}

function optionCostById(component) {
  if (!component?.options?.length) return 0;
  const recommendedId = component.recommendedOptionId ?? component.options[0].id;
  const option = component.options.find((item) => item.id === recommendedId) ?? component.options[0];

  if (typeof option.costUsd === "number") {
    return option.costUsd;
  }

  if (typeof option.nightlyUsd === "number" && typeof option.nights === "number") {
    return Number((option.nightlyUsd * option.nights).toFixed(2));
  }

  return 0;
}

function extractAgentText(result) {
  if (!result) return "";

  if (typeof result.finalOutput === "string") return result.finalOutput;
  if (result.finalOutput && typeof result.finalOutput === "object") {
    return JSON.stringify(result.finalOutput);
  }

  if (typeof result.outputText === "string") return result.outputText;
  if (typeof result.finalOutputText === "string") return result.finalOutputText;

  return "";
}

function parseAgentJson(rawText, agentName) {
  const text = rawText?.trim();
  if (!text) {
    throw new Error(`${agentName} returned empty output`);
  }

  const cleaned = stripMarkdownCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`${agentName} did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

function stripMarkdownCodeFence(text) {
  if (text.startsWith("```") && text.endsWith("```")) {
    return text.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
  }

  return text;
}

function summarizeResearch(research) {
  return {
    flightOptions: Array.isArray(research?.flightOptions) ? research.flightOptions.length : 0,
    hotelOptions: Array.isArray(research?.hotelOptions) ? research.hotelOptions.length : 0,
    carRentalOptions: Array.isArray(research?.carRentalOptions) ? research.carRentalOptions.length : 0,
    activityIdeas: Array.isArray(research?.activityIdeas) ? research.activityIdeas.length : 0
  };
}

function summarizeSafety(safety) {
  return {
    safetyConcerns: Array.isArray(safety?.safetyConcerns) ? safety.safetyConcerns.length : 0,
    packingItems: Array.isArray(safety?.packingList) ? safety.packingList.length : 0,
    localTransportTips: Array.isArray(safety?.localTransportAdvice) ? safety.localTransportAdvice.length : 0
  };
}

function summarizeItinerary(itinerary) {
  return {
    components: Object.keys(itinerary?.components ?? {}),
    activities: Array.isArray(itinerary?.activities) ? itinerary.activities.length : 0,
    estimatedTotalUsd: itinerary?.estimatedCostSummary?.totalUsd ?? null,
    daysAtDestination: itinerary?.stayAtDestination?.daysAtDestination ?? null,
    nightsAtDestination: itinerary?.stayAtDestination?.nightsAtDestination ?? null
  };
}

function normalizeHotelComponent(component, fallbackOptions, computedStay) {
  const base = normalizeComponent(component, fallbackOptions, "Please confirm this hotel option.");
  const nights = Math.max(1, Number(computedStay?.nightsAtDestination || 1));

  base.options = (base.options ?? []).map((option) => {
    const nightlyUsd = deriveNightlyRate(option);
    const costUsd = typeof nightlyUsd === "number" ? Number((nightlyUsd * nights).toFixed(2)) : option.costUsd;

    return {
      ...option,
      nightlyUsd: nightlyUsd ?? option.nightlyUsd,
      nights,
      costUsd,
      stayNights: nights
    };
  });

  return base;
}

function normalizeCarComponent(component, fallbackOptions, computedStay) {
  const base = normalizeComponent(component, fallbackOptions, "Please confirm this car rental option.");
  const rentalDays = Math.max(1, Number(computedStay?.daysAtDestination || 1));

  base.options = (base.options ?? []).map((option) => {
    const dailyRateUsd = deriveDailyCarRate(option);
    const costUsd = typeof dailyRateUsd === "number" ? Number((dailyRateUsd * rentalDays).toFixed(2)) : option.costUsd;

    return {
      ...option,
      dailyRateUsd: dailyRateUsd ?? option.dailyRateUsd,
      rentalDays,
      costUsd
    };
  });

  return base;
}

function deriveNightlyRate(option) {
  if (typeof option?.nightlyUsd === "number") return option.nightlyUsd;
  if (typeof option?.costUsd === "number" && typeof option?.nights === "number" && option.nights > 0) {
    return Number((option.costUsd / option.nights).toFixed(2));
  }
  return null;
}

function deriveDailyCarRate(option) {
  if (typeof option?.dailyRateUsd === "number") return option.dailyRateUsd;
  if (typeof option?.costUsd === "number" && typeof option?.rentalDays === "number" && option.rentalDays > 0) {
    return Number((option.costUsd / option.rentalDays).toFixed(2));
  }
  return null;
}

function computeDestinationStay(itinerary, researchJson, preferences) {
  const baseline = computeBaselineStay(preferences);
  const preferredFlightId = itinerary?.components?.flight?.recommendedOptionId;
  const flightOption =
    (researchJson?.flightOptions ?? []).find((option) => option.id === preferredFlightId) ??
    (researchJson?.flightOptions ?? [])[0] ??
    null;

  const arrival = parseDateSafe(flightOption?.outboundArrivalLocal);
  const departure = parseDateSafe(flightOption?.returnDepartureLocal);

  if (arrival && departure && departure > arrival) {
    const millisecondsPerDay = 24 * 60 * 60 * 1000;
    const rawDiffDays = (departure.getTime() - arrival.getTime()) / millisecondsPerDay;
    const nightsAtDestination = Math.max(1, Math.ceil(rawDiffDays));
    const daysAtDestination = Math.max(1, nightsAtDestination + 1);

    return {
      arrivalLocal: flightOption?.outboundArrivalLocal ?? arrival.toISOString(),
      departureLocal: flightOption?.returnDepartureLocal ?? departure.toISOString(),
      daysAtDestination: Math.min(daysAtDestination, baseline.daysAtDestination + 1),
      nightsAtDestination: Math.min(nightsAtDestination, baseline.nightsAtDestination + 1),
      calculationNote:
        "Calculated using flight arrival/departure schedule, with start/end date window as baseline (supports overnight travel)."
    };
  }

  return {
    arrivalLocal: baseline.arrivalLocal,
    departureLocal: baseline.departureLocal,
    daysAtDestination: baseline.daysAtDestination,
    nightsAtDestination: baseline.nightsAtDestination,
    calculationNote: "Calculated from start/end date window (flight schedule timestamps unavailable)."
  };
}

function computeBaselineStay(preferences) {
  const start = parseDateSafe(preferences?.startDate);
  const end = parseDateSafe(preferences?.endDate);

  if (!start || !end || end <= start) {
    return {
      arrivalLocal: preferences?.startDate ?? null,
      departureLocal: preferences?.endDate ?? null,
      daysAtDestination: Math.max(1, Number(preferences?.tripLengthDays || 1)),
      nightsAtDestination: Math.max(1, Number(preferences?.tripLengthDays || 1) - 1)
    };
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.ceil((end.getTime() - start.getTime()) / millisecondsPerDay);

  return {
    arrivalLocal: preferences?.startDate ?? null,
    departureLocal: preferences?.endDate ?? null,
    daysAtDestination: Math.max(1, diffDays + 1),
    nightsAtDestination: Math.max(1, diffDays)
  };
}

function parseDateSafe(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function runAgentWithTelemetry({ agent, agentName, stage, input, emit }) {
  emit({
    type: "agent_prompt",
    stage,
    agent: agentName,
    message: `Prompt sent to ${agentName}.`,
    prompt: input
  });

  const runner = new Runner();
  const monitor = attachStandardToolMonitoring(runner, {
    emit,
    stage,
    fallbackAgentName: agentName
  });

  const streamedResult = await runner.run(agent, input, { stream: true });

  for await (const event of streamedResult) {
    if (event?.type !== "run_item_stream_event") continue;

    const rawItem = event.item?.rawItem;
    if (!rawItem) continue;

    emit({
      type: "llm_run_item",
      stage,
      agent: agentName,
      message: `LLM run item: ${event.name}`,
      summary: {
        eventName: event.name,
        itemType: event.item?.type ?? null,
        rawItemType: rawItem?.type ?? null
      },
      rawItem: serializeRunItem(event.item)
    });

    emit({
      type: "stream_event",
      stage,
      agent: agentName,
      message: `Stream event: ${event.name}`,
      summary: {
        eventName: event.name,
        itemType: event.item?.type ?? null,
        rawItemType: rawItem?.type ?? null
      }
    });

    if (event.name === "tool_called" || isToolCallRawItem(rawItem)) {
      continue;
    }

    if (event.name === "tool_output" || isToolOutputRawItem(rawItem)) {
      continue;
    }
  }

  await streamedResult.completed;
  if (streamedResult.error) {
    throw streamedResult.error;
  }

  const responseText = extractAgentText(streamedResult);

  if (monitor.getCallCount() === 0) {
    emit({
      type: "tool_notice",
      stage,
      agent: agentName,
      message: "No tool calls were emitted in this agent run.",
      summary: {
        note: "Model may have responded directly without tool invocation."
      }
    });
  }

  emit({
    type: "agent_response",
    stage,
    agent: agentName,
    message: `Response received from ${agentName}.`,
    response: responseText
  });

  return streamedResult;
}

function extractToolName(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;
  return rawItem.name ?? rawItem.type ?? null;
}

function extractToolArguments(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;
  const value = rawItem.arguments;
  return normalizeDetailValue(value);
}

function extractToolOutput(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;
  if (typeof rawItem.output !== "undefined") {
    return normalizeDetailValue(rawItem.output);
  }

  return normalizeDetailValue(rawItem);
}

function normalizeDetailValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeRunItem(item) {
  if (!item) return null;

  try {
    if (typeof item.toJSON === "function") {
      return JSON.stringify(item.toJSON(), null, 2);
    }

    return JSON.stringify(item, null, 2);
  } catch {
    return String(item);
  }
}

function isToolCallRawItem(rawItem) {
  return rawItem?.type === "function_call" || rawItem?.type === "hosted_tool_call" || rawItem?.type === "computer_call";
}

function isToolOutputRawItem(rawItem) {
  return (
    rawItem?.type === "function_call_result" ||
    rawItem?.type === "computer_call_result" ||
    (rawItem?.type === "hosted_tool_call" && typeof rawItem?.output !== "undefined")
  );
}
