/*
 * Test script for Motor Husillo - Serial Control Simulation
 * Pin 10: Relay Control Signal
 * 
 * Commands (via Serial Monitor):
 * '1' or 'ON'  -> Spindle ON (Relay HIGH)
 * '0' or 'OFF' -> Spindle OFF (Relay LOW)
 */

const int relayPin = 10;

void setup() {
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, LOW); // Start with motor OFF
  
  Serial.begin(9600);
  Serial.println("--- Motor Husillo Serial Control ---");
  Serial.println("Commands: 1=ON, 0=OFF");
  Serial.println("Waiting for command...");
}

void loop() {
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim(); // Remove whitespace/newlines
    command.toUpperCase();

    if (command == "1" || command == "ON") {
      digitalWrite(relayPin, HIGH);
      Serial.println("> Motor: ON");
    } 
    else if (command == "0" || command == "OFF") {
      digitalWrite(relayPin, LOW);
      Serial.println("> Motor: OFF");
    }
    else {
      Serial.print("Unknown command: ");
      Serial.println(command);
    }
  }
}
