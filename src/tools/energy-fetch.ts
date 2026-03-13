import { db } from '../db/index.js';
import { energyDays, type EnergyDay } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type FetchEnergyInput = {
  label?: string;
};

export function fetchEnergy(input: FetchEnergyInput = {}): EnergyDay | undefined {
  if (input.label) {
    return db.select().from(energyDays).where(eq(energyDays.label, input.label)).get();
  }

  return db.select().from(energyDays).get();
}
