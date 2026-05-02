
#include <Servo.h>

// Servo pin based on firmware.ino
const int penServoPin = 10;
Servo penServo;

int currentPos = 90; // Starting position
bool isAttached = true;

void setup() {
  Serial.begin(9600);
  penServo.attach(penServoPin);
  penServo.write(currentPos);
  
  printMenu();
  showStatus();
}

void printMenu() {
  Serial.println("\n==============================");
  Serial.println("   SERVO CALIBRATION TOOL");
  Serial.println("==============================");
  Serial.println("Commands:");
  Serial.println("  '+' : Increase position (+1)");
  Serial.println("  '-' : Decrease position (-1)");
  Serial.println("  'u' : Move UP fast (+10)");
  Serial.println("  'd' : Move DOWN fast (-10)");
  Serial.println("  's' : STOP/RELEASE (Detach servo)");
  Serial.println("  'a' : ACTIVATE/HOLD (Attach servo)");
  Serial.println("  [0-180] : Go to exact position");
  Serial.println("  '?' : Show this menu");
  Serial.println("------------------------------");
}

void showStatus() {
  Serial.print(">>> CURRENT POSITION: ");
  Serial.print(currentPos);
  if (isAttached) {
    Serial.println(" [HOLDING/ACTIVE]");
  } else {
    Serial.println(" [RELEASED/STOPPED]");
  }
}

void loop() {
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    
    if (input.length() == 0) return;

    if (input == "+") {
      currentPos += 1;
    } else if (input == "-") {
      currentPos -= 1;
    } else if (input == "u") {
      currentPos += 10;
    } else if (input == "d") {
      currentPos -= 10;
    } else if (input == "s") {
      penServo.detach();
      isAttached = false;
      Serial.println("!!! SERVO STOPPED (Detached)");
      showStatus();
      return;
    } else if (input == "a") {
      penServo.attach(penServoPin);
      isAttached = true;
      penServo.write(currentPos);
      Serial.println("!!! SERVO ACTIVE (Holding)");
      showStatus();
      return;
    } else if (input == "?") {
      printMenu();
      showStatus();
      return;
    } else if (isNumeric(input)) {
      currentPos = input.toInt();
    } else {
      Serial.println("Unknown command: " + input);
      return;
    }

    // Constrain and Apply
    currentPos = constrain(currentPos, 0, 180);
    
    if (!isAttached) {
      penServo.attach(penServoPin);
      isAttached = true;
    }
    
    penServo.write(currentPos);
    showStatus();
  }
}

bool isNumeric(String str) {
  if (str.length() == 0) return false;
  for (byte i = 0; i < str.length(); i++) {
    if (!isDigit(str.charAt(i))) return false;
  }
  return true;
}
