/**
 * Writes apple/EverythingApp/Resources/SampleMealsTax.json: the hub's meals tax rates (src/mealstax.ts) and the US
 * state outlines it uses (assets/us-states.json). The Apple apps' sample mode has no hub, so it answers the bill
 * splitter's "Use my location" with this copy, the same way a hub would, and the position never leaves the device.
 * Run it again when the rates or the outlines change:
 *   cd hub && npx tsx scripts/sample-meals-tax.ts
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MEALS_TAX, loadShapes } from "../src/mealstax.js";

const shapes = loadShapes();
if (!shapes) throw new Error("assets/us-states.json is missing");
const out = fileURLToPath(new URL("../../apple/EverythingApp/Resources/SampleMealsTax.json", import.meta.url));
// The states as a list, in the outlines' order, which decides a point on a shared border as it does on the hub.
const states = Object.entries(shapes).map(([code, polygons]) => ({ code, polygons }));
fs.writeFileSync(out, JSON.stringify({ rates: MEALS_TAX, states }) + "\n");
console.log(`[sample] meals tax for ${Object.keys(MEALS_TAX).length} states written to ${out}`);
